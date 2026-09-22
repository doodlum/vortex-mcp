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
  /** True when it appears at some widths but not others — the interesting case. */
  widthDependent: boolean;
  detail: string;
}

export interface ResponsiveReport {
  page: string;
  viewports: Viewport[];
  /** Issues that appear only at some widths — the likely regressions. */
  regressions: ResponsiveFinding[];
  /** Issues present at every width — likely pre-existing, listed for completeness. */
  constant: ResponsiveFinding[];
  overflowWidths: number[];
  screenshots: string[];
  results: SweepViewportResult[];
}

/** Vortex's own minimum, a common laptop, and two desktop sizes. */
export const DEFAULT_VIEWPORTS: Viewport[] = [
  { width: 1024, height: 720 },
  { width: 1280, height: 800 },
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

  return { page, ...summarise(results), screenshots, results, viewports };
}

function summarise(results: SweepViewportResult[]): {
  regressions: ResponsiveFinding[];
  constant: ResponsiveFinding[];
  overflowWidths: number[];
} {
  const byKey = new Map<string, ResponsiveFinding>();

  for (const result of results) {
    for (const issue of result.issues) {
      const key = issueKey(issue);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          key,
          kind: issue.kind,
          selector: issue.selector,
          name: issue.name,
          widths: [result.viewport.width],
          widthDependent: false,
          detail: issue.detail,
        });
      } else {
        existing.widths.push(result.viewport.width);
      }
    }
  }

  const findings = [...byKey.values()].map((f) => ({
    ...f,
    widthDependent: f.widths.length !== results.length,
  }));

  return {
    regressions: findings.filter((f) => f.widthDependent),
    constant: findings.filter((f) => !f.widthDependent),
    overflowWidths: results.filter((r) => r.hasHorizontalOverflow).map((r) => r.viewport.width),
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
    lines.push(`Horizontal overflow at: ${report.overflowWidths.join(", ")}px`);
  }

  lines.push("");
  if (report.regressions.length === 0) {
    lines.push("No width-dependent layout issues.");
  } else {
    lines.push(`Width-dependent issues (${String(report.regressions.length)}) — look here first:`);
    for (const f of report.regressions) {
      lines.push(`  [${f.kind}] ${f.selector}${f.name === "" ? "" : ` "${f.name}"`}`);
      lines.push(`      only at ${f.widths.join(", ")}px — ${f.detail}`);
    }
  }

  if (report.constant.length > 0) {
    lines.push("");
    lines.push(
      `Present at every width (${String(report.constant.length)}) — likely pre-existing, not a regression:`,
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

  return lines.join("\n");
}
