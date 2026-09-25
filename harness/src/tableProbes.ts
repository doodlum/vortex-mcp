/**
 * Measurements of a Vortex SuperTable (`#table-<id>`) in the running renderer, over CDP.
 *
 * Harvested from the QA of Nexus-Mods/Vortex#24281 (sticky-header virtualisation), where
 * each had to be scripted by hand: how many rows render, how responsive wheel scrolling
 * is, whether rows accumulate after a scroll-through, which way a row's dropdown opens
 * near the edge of the scroll area, whether a noShrink column keeps its width, and how
 * well the conflict editor virtualises. `ai:test:mods-scroll` runs them as a scenario.
 *
 * Later QA added three more, each written by hand at least twice before: how many rows one
 * update gave a new data object and re-rendered (`measureRowIdentity`), blocking measured
 * until the page shows an action's result (`measureAfter`), and a dialog's content frame by
 * frame while it fades (`recordDialogFade`).
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

// ---------------------------------------------------------------------------
// Row identity: which rows one update gave a new data object, and which re-rendered
// ---------------------------------------------------------------------------

/**
 * Page source that instruments every mounted SuperTable (or only `tableIds`) and the TableRow
 * component, and resets the counters in `window.__vxRowId`:
 *
 *   - each table instance's `updateState`: per commit of `calculatedValues`, how many rows got a
 *     new object (`changedRefs`), how many of those hold no different value at all (`spurious`,
 *     JSON-compared per column), rows added and removed, and which columns differed (`keyHist`);
 *   - TableRow's prototype `shouldComponentUpdate` and `render`, per table: calls, how many
 *     calls got a new `data` object, how many of those were equal by value, how many returned
 *     true, and renders.
 *
 * Found through React's fiber tree (`__reactFiber$…` on `#table-<id>` and `tr[data-rowid]`),
 * which is a private shape: `installed.tables` is empty or `rowPrototype` false when a build
 * no longer matches. An in-place mutation of an existing row object is invisible here (the
 * reference is unchanged); TableRow's `dataChanged` still counts a new `data` prop.
 * Harvested from the QA of Nexus-Mods/Vortex#24284.
 */
export function rowIdentityInstallSource(tableIds?: string[]): string {
  return `(() => {
    const w = window;
    const store = { commits: [], scu: {}, renders: {} };
    w.__vxRowId = store;
    const wanted = ${JSON.stringify(tableIds ?? null)};
    const fiberOf = (el) => {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
      return key ? el[key] : null;
    };
    const same = (a, b) => {
      try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; }
    };
    const selector = wanted === null
      ? '[id^="table-"]'
      : wanted.map((id) => '[id="table-' + String(id).replace(/"/g, '\\\\"') + '"]').join(",");
    const tables = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      let f = fiberOf(el);
      let guard = 0;
      while (f && guard++ < 200) {
        const sn = f.stateNode;
        if (sn && sn.state && typeof sn.state === "object" && "calculatedValues" in sn.state &&
            sn.props && sn.props.tableId !== undefined && typeof sn.updateState === "function") {
          if (!tables.includes(sn.props.tableId)) tables.push(sn.props.tableId);
          if (sn.__vxOrigUpdateState === undefined) {
            sn.__vxOrigUpdateState = sn.updateState;
            sn.updateState = function (ns, cb) {
              const rec = window.__vxRowId;
              const old = this.state.calculatedValues;
              const next = ns && ns.calculatedValues;
              if (rec && old && next && old !== next) {
                let changedRefs = 0, spurious = 0, added = 0, removed = 0;
                const spuriousSample = [];
                const keyHist = {};
                for (const rowId of Object.keys(next)) {
                  if (old[rowId] === undefined) { added++; continue; }
                  if (old[rowId] === next[rowId]) continue;
                  changedRefs++;
                  const a = old[rowId] || {}, b = next[rowId] || {};
                  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
                  const diff = [...keys].filter((k) => (k in a) !== (k in b) || !same(a[k], b[k]));
                  for (const k of diff) keyHist[k] = (keyHist[k] || 0) + 1;
                  if (diff.length === 0) {
                    spurious++;
                    if (spuriousSample.length < 3) spuriousSample.push(rowId);
                  }
                }
                for (const rowId of Object.keys(old)) if (next[rowId] === undefined) removed++;
                rec.commits.push({ table: String(this.props.tableId), t: Math.round(performance.now()),
                  rows: Object.keys(next).length, changedRefs, spurious, added, removed, spuriousSample, keyHist });
              }
              return this.__vxOrigUpdateState.call(this, ns, cb);
            };
          }
          break;
        }
        f = f.return;
      }
    }
    let rowPrototype = false;
    for (const tr of Array.from(document.querySelectorAll("tr[data-rowid]"))) {
      let f = fiberOf(tr);
      let proto = null;
      let guard = 0;
      while (f && guard++ < 50) {
        const sn = f.stateNode;
        if (sn && sn.props && sn.props.rawData !== undefined && sn.props.tableId !== undefined &&
            typeof sn.shouldComponentUpdate === "function" && typeof sn.render === "function") {
          proto = Object.getPrototypeOf(sn);
          break;
        }
        f = f.return;
      }
      if (proto === null) continue;
      rowPrototype = true;
      if (!proto.__vxRowWrapped) {
        const scu = proto.shouldComponentUpdate, render = proto.render;
        proto.__vxOrigSCU = scu;
        proto.__vxOrigRender = render;
        proto.shouldComponentUpdate = function (np, ns) {
          const result = scu.call(this, np, ns);
          const rec = window.__vxRowId;
          if (rec) {
            const id = String(this.props.tableId);
            const s = (rec.scu[id] = rec.scu[id] || { calls: 0, dataChanged: 0, dataChangedNoValueDiff: 0, rendered: 0 });
            s.calls++;
            if (this.props.data !== np.data) {
              s.dataChanged++;
              if (same(this.props.data, np.data)) s.dataChangedNoValueDiff++;
            }
            if (result) s.rendered++;
          }
          return result;
        };
        proto.render = function () {
          const rec = window.__vxRowId;
          if (rec) {
            const id = String(this.props.tableId);
            rec.renders[id] = (rec.renders[id] || 0) + 1;
          }
          return render.call(this);
        };
        proto.__vxRowWrapped = true;
      }
      break;
    }
    return { tables, rowPrototype };
  })()`;
}

/** Page source: undo `rowIdentityInstallSource`'s wrappers. */
export const ROW_IDENTITY_RESTORE = `(() => {
  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
    return key ? el[key] : null;
  };
  let restored = 0;
  const seen = new Set();
  for (const el of Array.from(document.querySelectorAll('[id^="table-"], tr[data-rowid]'))) {
    let f = fiberOf(el);
    let guard = 0;
    while (f && guard++ < 200) {
      const sn = f.stateNode;
      if (sn && typeof sn === "object" && !seen.has(sn)) {
        seen.add(sn);
        if (sn.__vxOrigUpdateState !== undefined) {
          sn.updateState = sn.__vxOrigUpdateState;
          delete sn.__vxOrigUpdateState;
          restored++;
        }
        const proto = Object.getPrototypeOf(sn);
        if (proto && proto.__vxRowWrapped) {
          proto.shouldComponentUpdate = proto.__vxOrigSCU;
          proto.render = proto.__vxOrigRender;
          delete proto.__vxRowWrapped;
          restored++;
        }
      }
      f = f.return;
    }
  }
  window.__vxRowId = undefined;
  return restored;
})()`;

export interface RowIdentityCommit {
  table: string;
  /** performance.now() in the page when the commit happened. */
  t: number;
  rows: number;
  /** Rows whose calculated-values object is new in this commit. */
  changedRefs: number;
  /** Of those, rows whose values are all unchanged: a new object for nothing. */
  spurious: number;
  added: number;
  removed: number;
  spuriousSample: string[];
  /** Columns that differed, by how many rows. */
  keyHist: Record<string, number>;
}

export interface RowIdentityRaw {
  commits: RowIdentityCommit[];
  scu: Record<
    string,
    { calls: number; dataChanged: number; dataChangedNoValueDiff: number; rendered: number }
  >;
  renders: Record<string, number>;
}

export interface RowIdentityTable {
  commits: number;
  changedRefs: number;
  spurious: number;
  added: number;
  removed: number;
  /** TableRow shouldComponentUpdate calls, and how many got a new `data` object. */
  rowUpdates: number;
  rowDataChanged: number;
  rowDataChangedNoValueDiff: number;
  /** TableRow renders: rows that actually re-rendered. */
  rowRenders: number;
  keyHist: Record<string, number>;
}

/** Per table totals of what `rowIdentityInstallSource` recorded. */
export function summariseRowIdentity(raw: RowIdentityRaw): Record<string, RowIdentityTable> {
  const out: Record<string, RowIdentityTable> = {};
  const entry = (id: string): RowIdentityTable =>
    (out[id] ??= {
      commits: 0,
      changedRefs: 0,
      spurious: 0,
      added: 0,
      removed: 0,
      rowUpdates: 0,
      rowDataChanged: 0,
      rowDataChangedNoValueDiff: 0,
      rowRenders: 0,
      keyHist: {},
    });
  for (const commit of raw.commits) {
    const e = entry(commit.table);
    e.commits++;
    e.changedRefs += commit.changedRefs;
    e.spurious += commit.spurious;
    e.added += commit.added;
    e.removed += commit.removed;
    for (const [key, n] of Object.entries(commit.keyHist)) {
      e.keyHist[key] = (e.keyHist[key] ?? 0) + n;
    }
  }
  for (const [id, s] of Object.entries(raw.scu)) {
    const e = entry(id);
    e.rowUpdates += s.calls;
    e.rowDataChanged += s.dataChanged;
    e.rowDataChangedNoValueDiff += s.dataChangedNoValueDiff;
  }
  for (const [id, n] of Object.entries(raw.renders)) entry(id).rowRenders += n;
  return out;
}

export interface RowIdentityResult<T> extends AfterResult<T> {
  installed: { tables: string[]; rowPrototype: boolean };
  byTable: Record<string, RowIdentityTable>;
  commits: RowIdentityCommit[];
}

/**
 * Run one action and report, per table, how many rows it gave a new data object and how many
 * re-rendered, measured until `condition` (a page expression) holds and `afterMs` (default 3 s)
 * more. The instrumentation is removed afterwards, whatever happens.
 */
export async function measureRowIdentity<T>(
  page: Page,
  action: () => Promise<T>,
  condition: string,
  options: MeasureAfterOptions & { tables?: string[] } = {},
): Promise<RowIdentityResult<T>> {
  const installed = (await page.evaluate(rowIdentityInstallSource(options.tables))) as {
    tables: string[];
    rowPrototype: boolean;
  };
  try {
    const after = await measureAfter(page, action, condition, {
      ...options,
      afterMs: options.afterMs ?? 3_000,
    });
    const raw = (await page.evaluate("window.__vxRowId")) as RowIdentityRaw;
    return { ...after, installed, byTable: summariseRowIdentity(raw), commits: raw.commits };
  } finally {
    await page.evaluate(ROW_IDENTITY_RESTORE).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Measure an action until the page shows its result
// ---------------------------------------------------------------------------

/**
 * Page source: start watching for `condition` (a page expression) and recording long tasks, in
 * `window.__vxAfter`. The condition is checked on every DOM mutation and every 50 ms, so its
 * time is when the page first showed the result, not when a poller next looked.
 */
export function measureAfterInstallSource(condition: string): string {
  return `(() => {
    const w = window;
    if (w.__vxAfter && typeof w.__vxAfter.stop === "function") w.__vxAfter.stop();
    const check = () => {
      try { return !!(${condition}); } catch (e) { return false; }
    };
    const state = { start: performance.now(), metAt: null, tasks: [], checks: 0, initiallyTrue: check() };
    const tick = () => {
      if (state.metAt !== null) return;
      state.checks++;
      if (check()) state.metAt = performance.now();
    };
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) state.tasks.push([e.startTime, e.duration]);
      });
      observer.observe({ type: "longtask" });
    } catch (e) {
      observer = null;
    }
    const mutations = new MutationObserver(tick);
    mutations.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    const timer = setInterval(tick, 50);
    state.stop = () => { clearInterval(timer); mutations.disconnect(); if (observer) observer.disconnect(); };
    w.__vxAfter = state;
    return { initiallyTrue: state.initiallyTrue, longTasks: observer !== null };
  })()`;
}

/** Page source: stop watching and return what was recorded. */
export const MEASURE_AFTER_READ = `(() => {
  const s = window.__vxAfter;
  if (!s) return null;
  s.stop();
  window.__vxAfter = undefined;
  return { start: s.start, metAt: s.metAt, tasks: s.tasks, checks: s.checks, end: performance.now() };
})()`;

export interface AfterRaw {
  start: number;
  metAt: number | null;
  /** [startTime, duration] of each long task. */
  tasks: Array<[number, number]>;
  checks: number;
  end: number;
}

export interface BlockedSummary {
  longTasks: number;
  blockedMs: number;
  longestMs: number;
}

export interface AfterSummary {
  conditionMet: boolean;
  /** From the start of the action to the page first showing the result; null if it never did. */
  conditionMs: number | null;
  /** Long tasks that started before the result showed: the cost of getting it on screen. */
  untilCondition: BlockedSummary;
  /** Every long task in the window, the `afterMs` tail included. */
  total: BlockedSummary & { windowMs: number };
}

const blockedSummary = (tasks: Array<[number, number]>): BlockedSummary => ({
  longTasks: tasks.length,
  blockedMs: Math.round(tasks.reduce((sum, [, d]) => sum + d, 0)),
  longestMs: Math.round(Math.max(0, ...tasks.map(([, d]) => d))),
});

export function summariseAfter(raw: AfterRaw): AfterSummary {
  const until = raw.metAt ?? raw.end;
  return {
    conditionMet: raw.metAt !== null,
    conditionMs: raw.metAt === null ? null : Math.round(raw.metAt - raw.start),
    untilCondition: blockedSummary(raw.tasks.filter(([start]) => start < until)),
    total: { ...blockedSummary(raw.tasks), windowMs: Math.round(raw.end - raw.start) },
  };
}

export interface MeasureAfterOptions {
  /** Give up waiting for the condition after this long. Default 180 s. */
  timeoutMs?: number;
  /** Keep recording for this long after the condition holds. Default 0. */
  afterMs?: number;
  /** Measure even when the condition already holds before the action. Default false: throw. */
  allowInitiallyTrue?: boolean;
}

export interface AfterResult<T> extends AfterSummary {
  result: T;
  /** How long the action itself took to resolve, from this process. */
  actionMs: number;
  /** The page recorded no long tasks (PerformanceObserver "longtask" is unsupported). */
  longTasksUnavailable?: true;
}

/**
 * Run `action` (anything: an MCP call, a click, a page script) and measure the renderer until
 * `condition`, a page expression, first holds: when the table shows the change, rather than
 * "until idle". Reports the time to the result and the long tasks up to it, and those in an
 * optional `afterMs` tail. Throws when the condition already holds before the action, since it
 * then cannot show this action's result, unless `allowInitiallyTrue`.
 */
export async function measureAfter<T>(
  page: Page,
  action: () => Promise<T>,
  condition: string,
  options: MeasureAfterOptions = {},
): Promise<AfterResult<T>> {
  const install = (await page.evaluate(measureAfterInstallSource(condition))) as {
    initiallyTrue: boolean;
    longTasks: boolean;
  };
  if (install.initiallyTrue && options.allowInitiallyTrue !== true) {
    await page.evaluate(MEASURE_AFTER_READ).catch(() => undefined);
    throw new Error(
      "measureAfter: the condition already holds before the action, so it cannot show the " +
        `action's result: ${condition.slice(0, 200)}`,
    );
  }
  let raw: AfterRaw | null = null;
  try {
    const started = Date.now();
    const result = await action();
    const actionMs = Date.now() - started;
    const deadline = started + (options.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if ((await page.evaluate("!!window.__vxAfter && window.__vxAfter.metAt !== null")) === true) {
        break;
      }
      await sleep(page, 50);
    }
    if ((options.afterMs ?? 0) > 0) await sleep(page, options.afterMs ?? 0);
    raw = (await page.evaluate(MEASURE_AFTER_READ)) as AfterRaw;
    return {
      result,
      actionMs,
      ...summariseAfter(raw),
      ...(install.longTasks ? {} : { longTasksUnavailable: true as const }),
    };
  } finally {
    if (raw === null) await page.evaluate(MEASURE_AFTER_READ).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// A dialog's content, frame by frame, while it opens or closes
// ---------------------------------------------------------------------------

export interface DialogMatch {
  /** CSS selector of the dialog container. Default `.modal`. */
  selector?: string;
  /** Only a container whose text matches (a string: case-insensitive substring). */
  text?: RegExp | string;
}

export interface DialogFrameState {
  className: string;
  title: string | null;
  /** The container's text, first 300 characters. */
  text: string;
  /** Footer buttons (all buttons when there is no `.modal-footer`), with disabled marked. */
  buttons: Array<{ text: string; disabled: boolean }>;
}

export interface DialogFrame {
  /** Milliseconds since recording started. */
  ms: number;
  /** Null: no matching dialog in the DOM. */
  state: DialogFrameState | null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Page source: record the matching dialog on every DOM mutation into `window.__vxDialogRec`. */
export function dialogRecorderSource(match: DialogMatch = {}): string {
  const text =
    match.text === undefined
      ? null
      : typeof match.text === "string"
        ? { source: escapeRegExp(match.text), flags: "i" }
        : { source: match.text.source, flags: match.text.flags };
  return `(() => {
    const w = window;
    if (w.__vxDialogRec && typeof w.__vxDialogRec.stop === "function") w.__vxDialogRec.stop();
    const selector = ${JSON.stringify(match.selector ?? ".modal")};
    const text = ${JSON.stringify(text)};
    const pattern = text === null ? null : new RegExp(text.source, text.flags);
    const t0 = performance.now();
    const frames = [];
    let last;
    const clean = (s) => String(s || "").split(/\\s+/).join(" ").trim();
    const find = () => Array.from(document.querySelectorAll(selector))
      .find((el) => pattern === null || pattern.test(el.textContent || ""));
    const snap = () => {
      const el = find();
      let state = null;
      if (el) {
        const footer = el.querySelector(".modal-footer");
        const title = el.querySelector(".modal-title");
        state = {
          className: String(el.className || ""),
          title: title ? clean(title.textContent) : null,
          text: clean(el.textContent).slice(0, 300),
          buttons: Array.from((footer || el).querySelectorAll("button"))
            .map((b) => ({ text: clean(b.textContent), disabled: b.disabled === true })),
        };
      }
      const key = JSON.stringify(state);
      if (key !== last) {
        frames.push({ ms: Math.round(performance.now() - t0), state });
        last = key;
      }
    };
    const observer = new MutationObserver(snap);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    snap();
    w.__vxDialogRec = { frames, stop: () => observer.disconnect() };
    return frames.length;
  })()`;
}

/** Page source: stop recording and return the frames. */
export const DIALOG_RECORDER_READ = `(() => {
  const r = window.__vxDialogRec;
  if (!r) return null;
  r.stop();
  window.__vxDialogRec = undefined;
  return r.frames;
})()`;

export interface DialogRecording<T> {
  result: T;
  /** One entry per change of the dialog's class, title, text or buttons, deduplicated. */
  frames: DialogFrame[];
  /** Whether the dialog was gone from the DOM when recording stopped. */
  gone: boolean;
}

/**
 * Record a dialog's DOM on every mutation while `run` makes it close (or open, or change), so
 * what it shows during its fade transition is visible: a stale title, a button that flips, a
 * list that empties before the fade ends. Recording continues until nothing about the dialog
 * has changed for `settleMs` (default 500), at most `maxMs` (default 5 s) after `run`.
 * Harvested from three ad-hoc copies in the QA of Vortex's collection review screen.
 */
export async function recordDialogFade<T>(
  page: Page,
  match: DialogMatch,
  run: () => Promise<T>,
  options: { settleMs?: number; maxMs?: number } = {},
): Promise<DialogRecording<T>> {
  await page.evaluate(dialogRecorderSource(match));
  let frames: DialogFrame[] | null = null;
  try {
    const result = await run();
    const settle = options.settleMs ?? 500;
    const deadline = Date.now() + (options.maxMs ?? 5_000);
    let count = -1;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const now = (await page.evaluate(
        "window.__vxDialogRec ? window.__vxDialogRec.frames.length : -1",
      )) as number;
      if (now !== count) {
        count = now;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= settle) {
        break;
      }
      await sleep(page, 50);
    }
    frames = ((await page.evaluate(DIALOG_RECORDER_READ)) as DialogFrame[] | null) ?? [];
    return { result, frames, gone: frames.at(-1)?.state === null };
  } finally {
    if (frames === null) await page.evaluate(DIALOG_RECORDER_READ).catch(() => undefined);
  }
}
