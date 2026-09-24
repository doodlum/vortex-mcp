/**
 * Measurements of a Vortex SuperTable (`#table-<id>`) in the running renderer, over CDP.
 *
 * Harvested from the QA of Nexus-Mods/Vortex#24281 (sticky-header virtualisation), where
 * each had to be scripted by hand: how many rows render, how responsive wheel scrolling
 * is, whether rows accumulate after a scroll-through, which way a row's dropdown opens
 * near the edge of the scroll area, whether a noShrink column keeps its width, and how
 * well the conflict editor virtualises. `ai:test:mods-scroll` runs them as a scenario.
 *
 * Page code is sent as source text: tsx compiles named functions with an `__name` helper
 * the page does not have (KNOWLEDGE.md). The page-side builders are exported so the unit
 * tests can run them against a DOM.
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { deployMods } from "./deployment";
import type { VortexMcpClient } from "./mcpClient";

// ---------------------------------------------------------------------------
// Page-side source
// ---------------------------------------------------------------------------

/** Page source: `node` = the element that actually scrolls the table, or null. */
export function scrollerSource(tableId: string): string {
  return `
    let node = document.querySelector(${JSON.stringify(`#table-${tableId} .table-main-pane`)});
    while (node && !(node.scrollHeight > node.clientHeight &&
      ["auto", "scroll", "overlay"].includes(getComputedStyle(node).overflowY))) {
      node = node.parentElement;
    }`;
}

/**
 * Page expression: the table's rows between its header and the bottom of what scrolls
 * it. A placeholder row has one cell; a rendered row has one per column.
 */
export function rowsOnScreenSource(tableId: string): string {
  const table = JSON.stringify(`#table-${tableId}`);
  return `(() => {
    ${scrollerSource(tableId)}
    const rows = Array.from(document.querySelectorAll(${table} + " tr[data-rowid]"));
    const header = document.querySelector(${table} + " .xthead") ?? document.querySelector(${table} + " thead");
    const top = header ? header.getBoundingClientRect().bottom : 0;
    const bottom = node ? Math.min(window.innerHeight, node.getBoundingClientRect().bottom) : window.innerHeight;
    const visible = rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.height > 0 && box.bottom > top && box.top < bottom;
    });
    return {
      placeholders: visible.filter((row) => row.children.length <= 1).length,
      rendered: visible.filter((row) => row.children.length > 1).length,
      renderedTotal: rows.filter((row) => row.children.length > 1).length,
      total: rows.length,
    };
  })()`;
}

/** Page expression: scroll the table to a fraction of its height, with a scroll event. */
export function scrollToSource(tableId: string, fraction: number): string {
  return `(() => {
    ${scrollerSource(tableId)}
    if (!node) return false;
    node.scrollTop = (node.scrollHeight - node.clientHeight) * ${String(fraction)};
    node.dispatchEvent(new Event("scroll"));
    return true;
  })()`;
}

/** Page expression: the header cells' ids and widths. */
export function columnWidthsSource(tableId: string): string {
  return `(() => Array.from(document.querySelectorAll(${JSON.stringify(`#table-${tableId} .xthead .table-header-cell, #table-${tableId} thead th`)}))
    .map((cell) => ({
      id: cell.getAttribute("id") || (cell.className.split(" ").find((c) => c.startsWith("header-")) ?? ""),
      width: Math.round(cell.getBoundingClientRect().width),
    })))()`;
}

// ---------------------------------------------------------------------------
// Pure summaries
// ---------------------------------------------------------------------------

export interface RowsOnScreen {
  /** Rows on screen still showing a one-cell placeholder: blank rows the user sees. */
  placeholders: number;
  /** Rows on screen rendered in full. */
  rendered: number;
  /** Rows rendered in full anywhere in the table, on screen or not. */
  renderedTotal: number;
  /** Rows in the DOM, placeholders included. */
  total: number;
}

export interface FrameSummary {
  longTasks: number;
  longestMs: number;
  blockedMs: number;
  /** The longest gap between animation frames: what a user sees as the scroll freezing. */
  maxFrameGapMs: number;
  p95FrameMs: number;
  frames: number;
}

/** Summarise frame gaps and long-task durations sampled during an interaction. */
export function summariseFrames(frameGaps: number[], longTasks: number[]): FrameSummary {
  const sorted = frameGaps.toSorted((a, b) => b - a);
  return {
    longTasks: longTasks.length,
    longestMs: Math.round(Math.max(0, ...longTasks)),
    blockedMs: Math.round(longTasks.reduce((sum, t) => sum + t, 0)),
    maxFrameGapMs: Math.round(sorted[0] ?? 0),
    p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.05)] ?? 0),
    frames: sorted.length,
  };
}

export interface DropdownGeometry {
  rowTop: number;
  rowBottom: number;
  menuTop: number;
  menuBottom: number;
  /** Top and bottom of the visible scroll area (below the sticky header). */
  areaTop: number;
  areaBottom: number;
}

export interface DropdownVerdict {
  direction: "up" | "down";
  /** Pixels of the menu outside the visible scroll area; 0 when it fits. */
  clippedPx: number;
}

export function dropdownVerdict(g: DropdownGeometry): DropdownVerdict {
  const direction = g.menuTop + g.menuBottom < g.rowTop + g.rowBottom ? "up" : "down";
  const clippedPx = Math.max(0, g.areaTop - g.menuTop) + Math.max(0, g.menuBottom - g.areaBottom);
  return { direction, clippedPx: Math.round(clippedPx) };
}

export interface WidthSample {
  label: string;
  width: number;
}

/** A noShrink column may grow; it must never get narrower than it has been. */
export function shrinkingSamples(samples: WidthSample[]): WidthSample[] {
  let widest = -Infinity;
  const shrunk: WidthSample[] = [];
  for (const sample of samples) {
    if (sample.width < widest - 1) shrunk.push(sample);
    widest = Math.max(widest, sample.width);
  }
  return shrunk;
}

// ---------------------------------------------------------------------------
// Probes against a page
// ---------------------------------------------------------------------------

const sleep = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms);

export async function rowsOnScreen(page: Page, tableId: string): Promise<RowsOnScreen> {
  return (await page.evaluate(rowsOnScreenSource(tableId))) as RowsOnScreen;
}

export async function scrollTableTo(page: Page, tableId: string, fraction: number): Promise<void> {
  if (!((await page.evaluate(scrollToSource(tableId, fraction))) as boolean)) {
    throw new Error(`#table-${tableId} has no scrolling ancestor; is it on screen?`);
  }
}

/** Rows on screen at each of `at` milliseconds after a jump to `fraction`. */
export async function jumpAndSample(
  page: Page,
  tableId: string,
  fraction: number,
  at: number[] = [50, 300, 1_000],
): Promise<Record<string, RowsOnScreen>> {
  await scrollTableTo(page, tableId, fraction);
  const samples: Record<string, RowsOnScreen> = {};
  let waited = 0;
  for (const t of at) {
    await sleep(page, t - waited);
    waited = t;
    samples[`t${String(t)}`] = await rowsOnScreen(page, tableId);
  }
  return samples;
}

export interface WheelOptions {
  ticks: number;
  /** Pixels per wheel tick. Default 400. */
  delta?: number;
  /** Pause between ticks. Default 30 ms, a fast flick. */
  gapMs?: number;
  /** Stop early once the scroll area reaches its end. */
  untilEnd?: boolean;
}

export interface WheelResult extends FrameSummary {
  ticks: number;
  wallMs: number;
  /** Rows on screen right after the last tick, and 300 ms and 1 s later. */
  samples: Record<string, RowsOnScreen>;
  reachedEnd: boolean;
}

/** Scroll with real wheel input over the table body while sampling frames and long tasks. */
export async function wheelScroll(
  page: Page,
  tableId: string,
  options: WheelOptions,
): Promise<WheelResult> {
  const table = JSON.stringify(`#table-${tableId}`);
  await page.evaluate(`(() => {
    window.__vxTasks = []; window.__vxFrames = []; window.__vxRun = true;
    window.__vxObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__vxTasks.push(entry.duration);
    });
    window.__vxObserver.observe({ type: "longtask" });
    let last = performance.now();
    const frame = (t) => { window.__vxFrames.push(t - last); last = t; if (window.__vxRun) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  })()`);
  const box = (await page.evaluate(`(() => {
    const body = document.querySelector(${table} + " .xtbody") ?? document.querySelector(${table} + " tbody") ??
      document.querySelector(${table} + " .table-main-pane");
    const r = body.getBoundingClientRect();
    return { x: r.left + Math.min(300, r.width / 2), y: Math.min(window.innerHeight - 100, r.top + 200) };
  })()`)) as { x: number; y: number };
  await page.mouse.move(box.x, box.y);
  const atEnd = `(() => { ${scrollerSource(tableId)} return !node || node.scrollTop + node.clientHeight >= node.scrollHeight - 2; })()`;
  const start = Date.now();
  let ticks = 0;
  let reachedEnd = false;
  for (; ticks < options.ticks; ticks++) {
    await page.mouse.wheel(0, options.delta ?? 400);
    await sleep(page, options.gapMs ?? 30);
    if (
      options.untilEnd === true &&
      ticks % 10 === 9 &&
      ((await page.evaluate(atEnd)) as boolean)
    ) {
      reachedEnd = true;
      ticks++;
      break;
    }
  }
  const wallMs = Date.now() - start;
  const samples: Record<string, RowsOnScreen> = { t0: await rowsOnScreen(page, tableId) };
  await sleep(page, 300);
  samples.t300 = await rowsOnScreen(page, tableId);
  await sleep(page, 700);
  samples.t1000 = await rowsOnScreen(page, tableId);
  const { frames, tasks } = (await page.evaluate(`(() => {
    window.__vxRun = false; window.__vxObserver.disconnect();
    return { frames: window.__vxFrames.slice(1), tasks: window.__vxTasks };
  })()`)) as { frames: number[]; tasks: number[] };
  reachedEnd ||= (await page.evaluate(atEnd)) as boolean;
  return { ticks, wallMs, reachedEnd, samples, ...summariseFrames(frames, tasks) };
}

export interface DropdownProbe extends DropdownGeometry, DropdownVerdict {
  rowId: string | null;
}

/**
 * Open the dropdown in the first (`top`) or last (`bottom`) fully visible row and report
 * which way it opened and how much of it the scroll area clips. Closes it afterwards.
 */
export async function probeRowDropdown(
  page: Page,
  tableId: string,
  which: "top" | "bottom",
): Promise<DropdownProbe> {
  const table = JSON.stringify(`#table-${tableId}`);
  const geometry = (await page.evaluate(`(async () => {
    ${scrollerSource(tableId)}
    const header = document.querySelector(${table} + " .xthead") ?? document.querySelector(${table} + " thead");
    const areaTop = header ? header.getBoundingClientRect().bottom : 0;
    const areaBottom = node ? Math.min(window.innerHeight, node.getBoundingClientRect().bottom) : window.innerHeight;
    const rows = Array.from(document.querySelectorAll(${table} + " tr[data-rowid]")).filter((row) => {
      if (row.children.length <= 1 || !row.querySelector(".dropdown-toggle")) return false;
      const b = row.getBoundingClientRect();
      return b.top >= areaTop && b.bottom <= areaBottom - 4;
    });
    const row = ${JSON.stringify(which)} === "bottom" ? rows[rows.length - 1] : rows[0];
    if (!row) throw new Error("no fully visible row with a dropdown in " + ${table});
    const toggle = row.querySelector(".dropdown-toggle");
    for (const type of ["mousedown", "mouseup", "click"]) {
      toggle.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const menu = row.querySelector(".dropdown-menu");
    if (!menu) throw new Error("the row's dropdown opened no .dropdown-menu");
    const r = row.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    return { rowId: row.getAttribute("data-rowid"), rowTop: r.top, rowBottom: r.bottom,
      menuTop: m.top, menuBottom: m.bottom, areaTop, areaBottom };
  })()`)) as DropdownGeometry & { rowId: string | null };
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.mouse.click(5, 300).catch(() => undefined);
  await sleep(page, 400);
  return { ...geometry, ...dropdownVerdict(geometry) };
}

export async function columnWidths(
  page: Page,
  tableId: string,
): Promise<Array<{ id: string; width: number }>> {
  return (await page.evaluate(columnWidthsSource(tableId))) as Array<{ id: string; width: number }>;
}

// ---------------------------------------------------------------------------
// The conflict editor
// ---------------------------------------------------------------------------

export const CONFLICT_PREFIX = "vortex-ai-conflict-";

export interface ConflictFixture {
  gameId: string;
  modIds: string[];
}

/**
 * Seed `pairs` pairs of mods that deploy the same file, enable them and deploy, so Vortex
 * computes a conflict for every one of them. Sandbox only: it deploys.
 */
export async function seedConflictPairs(
  mcp: VortexMcpClient,
  pairs: number,
  options: { onProgress?: (message: string) => void } = {},
): Promise<ConflictFixture> {
  const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
  if (gameId !== "vortexaisandbox") {
    throw new Error(`The conflict fixture deploys; sandbox only (active: ${String(gameId)}).`);
  }
  const profile = await mcp.call<{ id: string }>("vortex_query", { selector: "activeProfile" });
  const staging = await mcp.call<string>("vortex_query", {
    selector: "installPathForGame",
    args: [gameId],
  });
  const modIds: string[] = [];
  const mods: unknown[] = [];
  const installTime = new Date().toISOString();
  for (let i = 0; i < pairs; i++) {
    const n = String(i).padStart(4, "0");
    for (const side of ["a", "b"]) {
      const id = `${CONFLICT_PREFIX}${side}-${n}`;
      modIds.push(id);
      const dir = path.join(staging, id, "conflicts");
      fs.mkdirSync(dir, { recursive: true });
      // Never rewrite an existing file: a deployed one is hardlinked into the game.
      const file = path.join(dir, `conflict-${n}.txt`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `${id}\n`);
      mods.push({
        id,
        state: "installed",
        type: "",
        installationPath: id,
        attributes: { name: `Conflict ${side.toUpperCase()} ${n}`, version: "1.0.0", installTime },
      });
    }
  }
  await mcp.call("vortex_dispatch", { action: "addMods", args: [gameId, mods] }, 300_000);
  await mcp.call(
    "set_mods_enabled",
    { modIds, enabled: true, profileId: profile.id, expectedActiveProfileId: profile.id },
    300_000,
  );
  await deployMods(mcp, gameId, { timeoutMs: 20 * 60 * 1000, onProgress: options.onProgress });
  return { gameId, modIds };
}

/** How many of the conflicting mods Vortex has conflict information for. */
export async function conflictCount(mcp: VortexMcpClient, modIds: string[]): Promise<number> {
  const conflicts = await mcp.call<Record<string, unknown[]> | null>("vortex_query", {
    path: ["session", "dependencies", "conflicts"],
  });
  return modIds.filter((id) => (conflicts?.[id]?.length ?? 0) > 0).length;
}

export interface ConflictEditorCounts {
  /** Entries rendered in full. */
  content: number;
  /** Entries still a placeholder. */
  placeholders: number;
  bodyScrollHeight: number | null;
  bodyClientHeight: number | null;
}

export const CONFLICT_EDITOR_COUNTS = `(() => {
  const dialog = document.querySelector("#conflict-editor-dialog");
  if (!dialog) return null;
  const body = dialog.querySelector(".modal-body");
  return {
    content: dialog.querySelectorAll('[id^="content-"]').length,
    placeholders: dialog.querySelectorAll('[id^="placeholder-"]').length,
    bodyScrollHeight: body ? body.scrollHeight : null,
    bodyClientHeight: body ? body.clientHeight : null,
  };
})()`;

export async function conflictEditorCounts(page: Page): Promise<ConflictEditorCounts | null> {
  return (await page.evaluate(CONFLICT_EDITOR_COUNTS)) as ConflictEditorCounts | null;
}

/** Open the conflict editor on the given mods (mod-dependency-manager's SET_CONFLICT_DIALOG). */
export async function openConflictEditor(
  mcp: VortexMcpClient,
  page: Page,
  fixture: ConflictFixture,
): Promise<void> {
  await mcp.call("vortex_dispatch", {
    action: "type:SET_CONFLICT_DIALOG",
    args: [{ gameId: fixture.gameId, modIds: fixture.modIds, modRules: [] }],
  });
  await page.waitForSelector("#conflict-editor-dialog", { timeout: 60_000 });
}

export async function closeConflictEditor(mcp: VortexMcpClient): Promise<void> {
  await mcp.call("vortex_dispatch", {
    action: "type:SET_CONFLICT_DIALOG",
    args: [{ gameId: undefined, modIds: undefined, modRules: undefined }],
  });
}

/**
 * Type into the conflict editor's filter one character at a time, as a user does (each
 * keystroke re-renders the editor). An empty `text` clears it.
 */
export async function typeConflictFilter(page: Page, text: string): Promise<void> {
  const steps = text === "" ? [""] : [...text].map((_, i) => text.slice(0, i + 1));
  for (const value of steps) {
    await page.evaluate(`(() => {
      const input = document.querySelector("#conflict-editor-dialog input[type=text]");
      if (!input) throw new Error("the conflict editor has no filter input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(page, 400);
  }
}
