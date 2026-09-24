/**
 * Responsive-layout testing across window sizes.
 *
 * The sweep loop lives here rather than in the extension's `ui_responsive_sweep`
 * for one reason: screenshots. The extension cannot take them (capturePage is
 * main-process only), so anything that wants a picture per size has to drive the
 * resize itself and capture over CDP between steps. `ui_responsive_sweep` is
 * still the right tool for an agent that only wants the structural findings in
 * one call.
 *
 * The other half of the value here is the *diff* across sizes. An issue present
 * at every width is almost always a pre-existing quirk of the component (a
 * deliberately-scrollable pane, an icon button that is simply small); one that
 * appears only below some width is the actual responsive regression. A raw
 * per-size issue list buries the second kind in the first.
 */
import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "./config";
import type { VortexMcpClient } from "./mcpClient";
import { attachToRenderer, captureScreenshot, type RendererHandle } from "./cdp";

export interface Viewport {
  width: number;
  height: number;
}

export interface LayoutIssue {
  kind: string;
  selector: string;
  role: string;
  name: string;
  detail: string;
  box: { x: number; y: number; width: number; height: number };
}

export interface SweepViewportResult {
  viewport: Viewport;
  actual: Viewport;
  inner: Viewport;
  hasHorizontalOverflow: boolean;
  issues: LayoutIssue[];
  screenshot?: string;
}

export interface ResponsiveFinding {
  /** Stable identity for an issue across viewports. */
  key: string;
  kind: string;
  selector: string;
  name: string;
  /** Widths at which this issue was observed. */
  widths: number[];
  viewports: Viewport[];
  viewportDependent: boolean;
  /** Legacy alias for viewportDependent; prefer viewports for width/height data. */
  widthDependent: boolean;
  detail: string;
}

export interface ResponsiveReport {
  page: string;
  viewports: Viewport[];
  /** Issues that appear only at some requested sizes; inspect their evidence. */
  regressions: ResponsiveFinding[];
  /** Issues present at every size. They may still be real defects. */
  constant: ResponsiveFinding[];
  overflowWidths: number[];
  overflowViewports: Viewport[];
  reportFile?: string;
  screenshots: string[];
  results: SweepViewportResult[];
}

/** Vortex's own minimum, a common laptop, and two desktop sizes. */
export const DEFAULT_VIEWPORTS: Viewport[] = [
  { width: 1024, height: 720 },
  { width: 1280, height: 800 },
  { width: 1280, height: 720 },
  { width: 1280, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

function issueKey(issue: LayoutIssue): string {
  return `${issue.kind}|${issue.selector}|${issue.name}`;
}

export interface SweepOptions {
  viewports?: Viewport[];
  screenshots?: boolean;
  /** Wait after each resize before scanning, for re-layout. */
  settleMs?: number;
  maxIssuesPerViewport?: number;
  label?: string;
}

/**
 * Resize through a list of viewports, scanning (and optionally photographing)
 * each, then restore the original size.
 *
 * The restore is in a `finally` so a mid-sweep failure cannot strand the user's
 * real Vortex window at 1024x720.
 */
export async function runResponsiveSweep(
  mcp: VortexMcpClient,
  config: HarnessConfig,
  options: SweepOptions = {},
): Promise<ResponsiveReport> {
  const viewports = options.viewports ?? DEFAULT_VIEWPORTS;
  const settleMs = options.settleMs ?? 400;
  const results: SweepViewportResult[] = [];

  const original = (await mcp.call<{ window: Viewport }>("ui_get_viewport")).window;
  const page = await currentPage(mcp);

  // One CDP connection for the whole sweep rather than one per viewport.
  let handle: RendererHandle | undefined;
  if (options.screenshots === true) {
    handle = await attachToRenderer(config);
  }

  const screenshots: string[] = [];
  try {
    for (const viewport of viewports) {
      const { actual } = await mcp.call<{ actual: Viewport }>("ui_set_viewport", {
        width: viewport.width,
        height: viewport.height,
      });
      await new Promise((resolve) => setTimeout(resolve, settleMs));

      const layout = await mcp.call<{
        viewport: Viewport;
        hasHorizontalOverflow: boolean;
        issues: LayoutIssue[];
      }>("ui_detect_layout_issues", { maxIssues: options.maxIssuesPerViewport ?? 25 });

      const result: SweepViewportResult = {
        viewport,
        actual,
        inner: layout.viewport,
        hasHorizontalOverflow: layout.hasHorizontalOverflow,
        issues: layout.issues,
      };

      if (handle !== undefined) {
        const file = await captureScreenshot(config, {
          handle,
          label: `${options.label ?? "sweep"}-${String(viewport.width)}x${String(viewport.height)}`,
        });
        result.screenshot = file;
        screenshots.push(file);
      }

      results.push(result);
    }
  } finally {
    await mcp
      .call("ui_set_viewport", { width: original.width, height: original.height })
      .catch(() => undefined);
    await handle?.close();
  }

  const report: ResponsiveReport = { page, ...summarise(results), screenshots, results, viewports };
  fs.mkdirSync(config.artifactDir, { recursive: true });
  const label = (options.label ?? "sweep").replace(/[^a-zA-Z0-9._-]/g, "_");
  report.reportFile = path.join(
    config.artifactDir,
    `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(report.reportFile, JSON.stringify(report, null, 2));
  return report;
}

export function summarise(results: SweepViewportResult[]): {
  regressions: ResponsiveFinding[];
  constant: ResponsiveFinding[];
  overflowWidths: number[];
  overflowViewports: Viewport[];
} {
  const byKey = new Map<string, ResponsiveFinding>();

  for (const result of results) {
    const seen = new Set<string>();
    for (const issue of result.issues) {
      const key = issueKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          key,
          kind: issue.kind,
          selector: issue.selector,
          name: issue.name,
          widths: [result.viewport.width],
          viewports: [result.viewport],
          viewportDependent: false,
          widthDependent: false,
          detail: issue.detail,
        });
      } else {
        existing.widths.push(result.viewport.width);
        existing.viewports.push(result.viewport);
      }
    }
  }

  const findings = [...byKey.values()].map((f) => ({
    ...f,
    widthDependent: f.widths.length !== results.length,
    viewportDependent: f.viewports.length !== results.length,
  }));

  return {
    regressions: findings.filter((f) => f.widthDependent),
    constant: findings.filter((f) => !f.widthDependent),
    overflowWidths: results.filter((r) => r.hasHorizontalOverflow).map((r) => r.viewport.width),
    overflowViewports: results.filter((r) => r.hasHorizontalOverflow).map((r) => r.viewport),
  };
}

/** Best-effort label for what was on screen, so a report is self-describing. */
async function currentPage(mcp: VortexMcpClient): Promise<string> {
  try {
    const snapshot = await mcp.call<{ url: string; title: string }>("ui_snapshot", {
      maxNodes: 1,
      maxDepth: 1,
    });
    return `${snapshot.title} (${snapshot.url})`;
  } catch {
    return "unknown";
  }
}

/** Render a report as something readable in a terminal. */
export function formatReport(report: ResponsiveReport): string {
  const lines: string[] = [];
  lines.push(`Responsive sweep — ${report.page}`);
  lines.push(
    `Viewports: ${report.viewports.map((v) => `${String(v.width)}x${String(v.height)}`).join(", ")}`,
  );

  if (report.overflowWidths.length > 0) {
    lines.push(
      `Horizontal overflow at: ${report.overflowViewports.map((v) => `${v.width}x${v.height}`).join(", ")}`,
    );
  }

  lines.push("");
  if (report.regressions.length === 0) {
    lines.push(
      "No viewport-dependent layout issues detected. Review screenshots and constant findings too.",
    );
  } else {
    lines.push(`Viewport-dependent issues (${String(report.regressions.length)}):`);
    for (const f of report.regressions) {
      lines.push(`  [${f.kind}] ${f.selector}${f.name === "" ? "" : ` "${f.name}"`}`);
      lines.push(
        `      at ${f.viewports.map((v) => `${v.width}x${v.height}`).join(", ")} — ${f.detail}`,
      );
    }
  }

  if (report.constant.length > 0) {
    lines.push("");
    lines.push(
      `Present at every viewport (${String(report.constant.length)}) — review separately:`,
    );
    for (const f of report.constant.slice(0, 15)) {
      lines.push(`  [${f.kind}] ${f.selector}${f.name === "" ? "" : ` "${f.name}"`}`);
    }
    if (report.constant.length > 15) {
      lines.push(`  ... and ${String(report.constant.length - 15)} more`);
    }
  }

  if (report.screenshots.length > 0) {
    lines.push("");
    lines.push("Screenshots:");
    for (const file of report.screenshots) lines.push(`  ${file}`);
  }

  if (report.reportFile) lines.push(`\nJSON report: ${report.reportFile}`);
  return lines.join("\n");
}

/**
 * `--viewports` as one comma-separated string. Unquoted in PowerShell, `a,b` is an array.
 * Through pnpm's pnpm.ps1 shim it arrives as one space-separated argument ("a b"); called
 * directly it can arrive as separate arguments, the rest as positionals. Both are rejoined.
 */
export function viewportList(
  value: string | boolean | undefined,
  positional: string[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  const extra = positional.filter((p) => /^\d+x\d+(?:[\s,]+\d+x\d+)*$/.test(p.trim()));
  return [value, ...extra]
    .flatMap((part) => part.trim().split(/[\s,]+/))
    .filter((part) => part !== "")
    .join(",");
}
