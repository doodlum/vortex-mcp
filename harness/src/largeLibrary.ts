/**
 * A large mod library as a fixture, and the measurements that show whether Vortex
 * copes with one.
 *
 * Reports of Vortex slowing down only ever come from users with thousands of mods,
 * and nobody reproduces those by downloading a real 3,000-mod collection. Nothing
 * about the slowdowns needs real mods, though: deployment links whatever files a
 * mod's staging folder holds, and the Mods page renders whatever is in state. So
 * this writes N small staging folders straight to disk and registers them through
 * Vortex's own `addMods` action — the same records an installer produces — in one
 * dispatch, which takes seconds instead of hours and needs no account.
 *
 * The measurements run against the rendered page over CDP, because the thing
 * being measured is the renderer: how many table rows it actually rendered, how
 * long it spent blocked while filtering, and how long a deploy takes with a given
 * page on screen.
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { deployMods } from "./deployment";
import type { VortexMcpClient } from "./mcpClient";

/** Prefix of every mod id this fixture creates, so they can be told apart and removed. */
export const LIBRARY_PREFIX = "vortex-ai-library-";

export interface LibraryOptions {
  count: number;
  /** Files per mod. Deployment cost scales with files, rendering cost with mods. */
  filesPerMod?: number;
}

export interface Library {
  gameId: string;
  profileId: string;
  modIds: string[];
}

const modId = (index: number): string => `${LIBRARY_PREFIX}${String(index).padStart(5, "0")}`;

/**
 * Write the staging folders and register them as installed, enabled mods of the
 * active game.
 *
 * Idempotent for a given count: folders that exist are rewritten, mods that are
 * already in state are replaced by the same records.
 */
export async function seedLibrary(mcp: VortexMcpClient, options: LibraryOptions): Promise<Library> {
  const filesPerMod = options.filesPerMod ?? 3;
  const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
  if (!gameId) throw new Error("Manage a game before seeding a mod library.");
  const profile = await mcp.call<{ id: string } | null>("vortex_query", {
    selector: "activeProfile",
  });
  if (!profile) throw new Error(`No active profile for ${gameId}.`);
  const staging = await mcp.call<string>("vortex_query", {
    selector: "installPathForGame",
    args: [gameId],
  });

  const installTime = new Date().toISOString();
  const mods = Array.from({ length: options.count }, (_, index) => {
    const id = modId(index);
    const dir = path.join(staging, id);
    fs.mkdirSync(path.join(dir, "library"), { recursive: true });
    for (let file = 0; file < filesPerMod; file++) {
      // Never rewrite one that exists: a deployed staging file is hardlinked into the
      // game, so rewriting it looks to Vortex like an edit made outside it.
      const target = path.join(dir, "library", `${id}-${String(file)}.txt`);
      if (!fs.existsSync(target)) fs.writeFileSync(target, `${id} ${String(file)}\n`);
    }
    return {
      id,
      state: "installed",
      type: "",
      installationPath: id,
      attributes: {
        name: `Library Mod ${String(index).padStart(5, "0")}`,
        version: "1.0.0",
        installTime,
      },
    };
  });

  await mcp.call("vortex_dispatch", { action: "addMods", args: [gameId, mods] }, 300_000);
  const modIds = mods.map((mod) => mod.id);
  await mcp.call(
    "set_mods_enabled",
    { modIds, enabled: true, profileId: profile.id, expectedActiveProfileId: profile.id },
    300_000,
  );
  return { gameId, profileId: profile.id, modIds };
}

export interface TableRows {
  /** Rows in the DOM, placeholders included. */
  total: number;
  /** Rows rendered with their cells, rather than as a one-cell placeholder. */
  rendered: number;
  /** Rendered rows that are actually inside the window. */
  onScreen: number;
}

/**
 * Count the rows of a SuperTable. A row scrolled out of view is supposed to be a
 * single-cell placeholder; one rendered in full has a cell per column.
 */
export async function tableRows(page: Page, tableId: string): Promise<TableRows> {
  return page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(`#table-${tableId} tr[data-rowid]`)}));
    const rendered = rows.filter((row) => row.children.length > 1);
    const onScreen = rendered.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight;
    });
    return { total: rows.length, rendered: rendered.length, onScreen: onScreen.length };
  })()`);
}

export interface BlockedTime {
  /** Wall-clock time until the renderer settled. */
  elapsedMs: number;
  /** Sum of main-thread tasks over 50ms, the time the UI could not respond. */
  blockedMs: number;
  /** The longest single task. */
  longestMs: number;
}

/**
 * Run `action` in the page and measure how long the renderer's main thread was
 * blocked until it had been idle for `settleMs`.
 */
export async function measureBlocked(
  page: Page,
  action: string,
  settleMs = 1_000,
): Promise<BlockedTime> {
  // Sent as source text: tsx compiles named functions with an `__name` helper that
  // exists in the harness, not in the page, so a function passed to evaluate throws.
  return page.evaluate(`(async () => {
    const tasks = [];
    let last = performance.now();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push(entry.duration);
        last = Math.max(last, entry.startTime + entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    const start = performance.now();
    await (async () => { ${action} })();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (performance.now() - last >= ${String(settleMs)}) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
    observer.disconnect();
    return {
      elapsedMs: Math.round(last - start),
      blockedMs: Math.round(tasks.reduce((sum, t) => sum + t, 0)),
      longestMs: Math.round(Math.max(0, ...tasks)),
    };
  })()`);
}

/**
 * Page code that types `value` into a table's name filter the way React sees
 * typing: through the prototype's value setter, then an input event.
 */
export function fillFilterScript(tableId: string, value: string): string {
  return `
    const input = document.querySelector('#table-${tableId} input[type="text"]');
    if (!input) throw new Error('no text filter in #table-${tableId}');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  `;
}

/**
 * Deploy and return how long it took, in milliseconds. Progress, including a dialog
 * the watcher will not answer, goes to the console: otherwise a deploy blocked on a
 * modal looks exactly like a slow one.
 */
export async function timeDeploy(mcp: VortexMcpClient, gameId: string): Promise<number> {
  const start = Date.now();
  await deployMods(mcp, gameId, { timeoutMs: 60 * 60 * 1000, onProgress: console.log });
  return Date.now() - start;
}
