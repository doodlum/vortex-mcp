/**
 * Opt-in check of the Mods table while scrolling, against a running sandbox instance:
 * pnpm run ai:test:mods-scroll.
 *
 * Seeds a large library (largeLibrary.ts) and measures, with real wheel input over CDP:
 *
 * - rows rendered on arrival (a screenful, not the library);
 * - scroll responsiveness: the longest frame gap and long task while flicking 40 wheel
 *   ticks, and blank placeholder rows left on screen once the scroll settles;
 * - dropdown direction: the top visible row's dropdown must open inside the scroll area,
 *   and so must the bottom one's (opening down past the edge clips it);
 * - noShrink width: with a band of disabled mods mid-list, the Status column may widen
 *   when the band scrolls into view and must not narrow again once it scrolls away;
 * - row accumulation: rows still rendered after one scroll through the whole list, and
 *   what clearing the name filter then costs. Stock Vortex keeps every row it has shown
 *   (VisibilityProxy ignores "not visible" within 1 s of becoming visible, and the
 *   observer never reports again; KNOWLEDGE.md), so this is reported, and fails only with
 *   --max-accumulated <n>;
 * - with --conflicts <pairs>: the conflict editor opened on 2 × pairs conflicting mods must
 *   keep virtualising its entries on open, after typing in its filter and after clearing it.
 *
 *   --mods <n>             library size (default 3000)
 *   --layout <l>           modern | classic (default modern)
 *   --max-frame-gap <ms>   budget for the wheel flick (default 300)
 *   --max-accumulated <n>  fail when more rows than this stay rendered after a scroll-through
 *   --conflicts <pairs>    also run the conflict-editor fixture (it deploys; minutes)
 *   --no-scroll-through    skip the scroll-through, which takes a minute or two
 *
 * It needs no account. Sandbox only, because the conflict fixture deploys.
 */
import fs from "node:fs";
import path from "node:path";

import { attachToRenderer, captureScreenshot } from "../cdp";
import { loadConfig } from "../config";
import { claimInstanceLease } from "../instance";
import { fillFilterScript, measureBlocked, seedLibrary } from "../largeLibrary";
import { VortexMcpClient } from "../mcpClient";
import {
  closeConflictEditor,
  columnWidths,
  conflictCount,
  conflictEditorCounts,
  jumpAndSample,
  openConflictEditor,
  probeRowDropdown,
  rowsOnScreen,
  scrollTableTo,
  seedConflictPairs,
  shrinkingSamples,
  typeConflictFilter,
  wheelScroll,
  type WidthSample,
} from "../tableProbes";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const count = Number(flag("mods") ?? 3000);
const layout = flag("layout") ?? "modern";
const maxFrameGap = Number(flag("max-frame-gap") ?? 300);
const maxAccumulated =
  flag("max-accumulated") === undefined ? undefined : Number(flag("max-accumulated"));
const conflictPairs = Number(flag("conflicts") ?? 0);
const scrollThrough = !process.argv.includes("--no-scroll-through");

/** A screenful plus the observer's margins, generously. */
const MAX_RENDERED_ROWS = 200;
/** Pixels of a dropdown the scroll area may cut off. */
const MAX_CLIPPED_PX = 2;
const TABLE = "mods";

const config = loadConfig();
claimInstanceLease(config, "ai:test:mods-scroll");
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
if (gameId !== "vortexaisandbox") {
  throw new Error(
    `This check runs only on the sandbox game (active: ${String(gameId)}). ` +
      "Start the instance with `vortex-ai up --sandbox`.",
  );
}
const status = await mcp.call<{ nodeEnv: string | null }>("automation_status");
const originalLayout = await mcp.call<boolean>("vortex_query", {
  path: ["settings", "window", "useModernLayout"],
});
const handle = await attachToRenderer(config);
const { page } = handle;
const failures: string[] = [];
const warnings: string[] = [];
const result: Record<string, unknown> = { count, layout, nodeEnv: status.nodeEnv };

const openPage = async (id: string): Promise<void> => {
  await mcp.call("vortex_dispatch", { action: "setOpenMainPage", args: [id, false] });
  await page.waitForTimeout(3_000);
};

try {
  await mcp.call("vortex_dispatch", { action: "setUseModernLayout", args: [layout === "modern"] });
  await page.waitForTimeout(3_000);
  const library = await seedLibrary(mcp, { count });
  await openPage("Mods");
  await page.waitForSelector(`#table-${TABLE} tr[data-rowid]`, { timeout: 60_000 });
  await scrollTableTo(page, TABLE, 0);
  await page.waitForTimeout(6_000);

  const arrival = await rowsOnScreen(page, TABLE);
  result.arrival = arrival;
  if (arrival.renderedTotal > MAX_RENDERED_ROWS) {
    failures.push(
      `${String(arrival.renderedTotal)} rows rendered on arrival (allowed ${String(MAX_RENDERED_ROWS)})`,
    );
  }

  // A fast flick: 40 wheel ticks, 30 ms apart.
  const wheel = await wheelScroll(page, TABLE, { ticks: 40, delta: 400, gapMs: 30 });
  result.wheel = wheel;
  if (wheel.maxFrameGapMs > maxFrameGap) {
    failures.push(
      `wheel scrolling froze for up to ${String(wheel.maxFrameGapMs)}ms between frames ` +
        `(longest task ${String(wheel.longestMs)}ms; allowed ${String(maxFrameGap)})`,
    );
  }
  const settled = wheel.samples.t1000;
  if (settled !== undefined && settled.placeholders > 0) {
    failures.push(
      `${String(settled.placeholders)} blank rows on screen 1s after the wheel stopped`,
    );
  }
  result.jumps = {
    bottom: await jumpAndSample(page, TABLE, 1),
    middle: await jumpAndSample(page, TABLE, 0.5),
  };

  // Dropdowns at both edges of the scroll area, at the top and the bottom of the list.
  const dropdowns: Record<string, unknown> = {};
  for (const [at, which] of [
    [0, "top"],
    [0, "bottom"],
    [1, "top"],
    [1, "bottom"],
  ] as const) {
    await scrollTableTo(page, TABLE, at);
    await page.waitForTimeout(1_500);
    const probe = await probeRowDropdown(page, TABLE, which);
    dropdowns[`${String(at)}-${which}`] = probe;
    if (probe.clippedPx > MAX_CLIPPED_PX) {
      failures.push(
        `the ${which} row's dropdown (list at ${String(at * 100)}%) opened ${probe.direction} ` +
          `and the scroll area cuts off ${String(probe.clippedPx)}px of it`,
      );
    }
  }
  result.dropdowns = dropdowns;
  await captureScreenshot(config, { label: `mods-scroll-${layout}`, handle });

  // noShrink: disable a band mid-list, whose longer "Disabled" status widens the column.
  const band = library.modIds.slice(Math.floor(count * 0.45), Math.floor(count * 0.55));
  await mcp.call(
    "set_mods_enabled",
    { modIds: band, enabled: false, profileId: library.profileId },
    300_000,
  );
  const widths: WidthSample[] = [];
  const statusWidth = async (label: string): Promise<void> => {
    const cols = await columnWidths(page, TABLE);
    const column = cols.find((c) => /enabled/i.test(c.id));
    if (column !== undefined) widths.push({ label, width: column.width });
  };
  for (const [label, at, wait] of [
    ["top", 0, 1_500],
    ["band", 0.5, 1_500],
    ["band again", 0.5, 1_500],
    ["top again", 0, 1_500],
    ["top after unmount", 0, 7_000],
  ] as const) {
    await scrollTableTo(page, TABLE, at);
    await page.waitForTimeout(wait);
    await statusWidth(label);
  }
  await mcp.call(
    "set_mods_enabled",
    { modIds: band, enabled: true, profileId: library.profileId },
    300_000,
  );
  result.statusColumnWidths = widths;
  if (widths.length === 0) {
    warnings.push("no Status (enabled) column header found; noShrink not checked");
  }
  for (const shrunk of shrinkingSamples(widths)) {
    failures.push(`the Status column narrowed to ${String(shrunk.width)}px at "${shrunk.label}"`);
  }

  if (scrollThrough) {
    await scrollTableTo(page, TABLE, 0);
    await page.waitForTimeout(6_000);
    const through = await wheelScroll(page, TABLE, {
      ticks: 5_000,
      delta: 400,
      gapMs: 30,
      untilEnd: true,
    });
    await page.waitForTimeout(6_000);
    const after = await rowsOnScreen(page, TABLE);
    await measureBlocked(page, fillFilterScript(TABLE, "Mod 0001"));
    const clear = await measureBlocked(page, fillFilterScript(TABLE, ""));
    result.scrollThrough = {
      ticks: through.ticks,
      reachedEnd: through.reachedEnd,
      wallMs: through.wallMs,
      blockedMs: through.blockedMs,
      maxFrameGapMs: through.maxFrameGapMs,
      renderedAfter: after.renderedTotal,
      clearAfter: clear,
    };
    const note =
      `${String(after.renderedTotal)} rows stay rendered after one scroll-through; clearing ` +
      `the filter then blocked ${String(clear.blockedMs)}ms`;
    if (maxAccumulated !== undefined && after.renderedTotal > maxAccumulated) {
      failures.push(`${note} (allowed ${String(maxAccumulated)} rows)`);
    } else if (after.renderedTotal > MAX_RENDERED_ROWS) {
      warnings.push(`${note} (rows never unmount once shown; see KNOWLEDGE.md)`);
    }
  }

  if (conflictPairs > 0) {
    const fixture = await seedConflictPairs(mcp, conflictPairs, { onProgress: console.log });
    let known = 0;
    for (let i = 0; i < 60 && known < fixture.modIds.length; i++) {
      known = await conflictCount(mcp, fixture.modIds);
      if (known < fixture.modIds.length) await page.waitForTimeout(2_000);
    }
    await openPage("Mods");
    await openConflictEditor(mcp, page, fixture);
    try {
      await page.waitForTimeout(4_000);
      const open = await conflictEditorCounts(page);
      await typeConflictFilter(page, "Conflict");
      await page.waitForTimeout(3_000);
      const typed = await conflictEditorCounts(page);
      await typeConflictFilter(page, "");
      await page.waitForTimeout(3_000);
      const cleared = await conflictEditorCounts(page);
      await captureScreenshot(config, { label: "mods-scroll-conflicts", handle });
      result.conflicts = { pairs: conflictPairs, withConflicts: known, open, typed, cleared };
      for (const [when, counts] of Object.entries({ open, typed, cleared })) {
        if (counts === null) {
          failures.push(`the conflict editor was not open ${when}`);
        } else if (counts.content > MAX_RENDERED_ROWS) {
          failures.push(
            `the conflict editor rendered ${String(counts.content)} entries in full ${when} ` +
              `(${String(counts.placeholders)} placeholders; allowed ${String(MAX_RENDERED_ROWS)})`,
          );
        }
      }
    } finally {
      await closeConflictEditor(mcp).catch(() => undefined);
    }
  }
} finally {
  await mcp
    .call("vortex_dispatch", { action: "setUseModernLayout", args: [originalLayout !== false] })
    .catch(() => undefined);
  await handle.close();
}

result.failures = failures;
result.warnings = warnings;
fs.mkdirSync(config.artifactDir, { recursive: true });
const report = path.join(config.artifactDir, `mods-scroll-${layout}-${String(Date.now())}.json`);
fs.writeFileSync(report, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(`evidence: ${report}`);
for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
