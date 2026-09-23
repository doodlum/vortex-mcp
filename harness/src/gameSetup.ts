/**
 * Getting a game managed without going through Vortex's discovery scan or its UI.
 *
 * The harness runs instances with `VORTEX_E2E=1`, which disables startup game
 * discovery (see instance.ts for why that flag is unavoidable). Rather than
 * re-enabling a filesystem scan, the harness finds the install itself — from
 * Steam's own manifests, which is exact — and tells Vortex where it is. That is
 * both faster than a scan and deterministic: the same game path every run, on
 * every machine, with no dependence on what a scan happens to turn up.
 */
import fs from "node:fs";
import path from "node:path";

import { assertRedirected } from "./bethesdaSandbox";
import type { HarnessConfig } from "./config";
import type { VortexMcpClient } from "./mcpClient";
import { realHover } from "./cdp";
import { withUiLock } from "./uiSession";
import {
  autoAnswerDialogs,
  clickByName,
  findNodes,
  snapshot,
  waitForNode,
  type AnsweredDialog,
} from "./uiDriver";

export interface GameDefinition {
  /** Vortex's game id. */
  id: string;
  /** Human name, for messages. */
  name: string;
  /** Steam application id, when the game is on Steam. */
  steamAppId?: string;
  /** Directory name under steamapps/common. */
  steamDir?: string;
  /** Executable relative to the game's base path — used to sanity-check a candidate. */
  executable: string;
}

/**
 * Games the harness knows how to locate unaided.
 *
 * Small on purpose: this is a convenience for the common case, not a second
 * copy of Vortex's game registry. Anything not here still works — pass an
 * explicit path to `ensureGameManaged`.
 */
export const KNOWN_GAMES: Record<string, GameDefinition> = {
  vortexaisandbox: {
    id: "vortexaisandbox",
    name: "Vortex Automation Sandbox",
    executable: "game.exe",
  },
  fallout4: {
    id: "fallout4",
    name: "Fallout 4",
    steamAppId: "377160",
    steamDir: "Fallout 4",
    executable: "Fallout4.exe",
  },
  falloutnv: {
    id: "falloutnv",
    name: "Fallout: New Vegas",
    steamAppId: "22380",
    steamDir: "Fallout New Vegas",
    executable: "FalloutNV.exe",
  },
  skyrimse: {
    id: "skyrimse",
    name: "Skyrim Special Edition",
    steamAppId: "489830",
    steamDir: "Skyrim Special Edition",
    executable: "SkyrimSE.exe",
  },
  stardewvalley: {
    id: "stardewvalley",
    name: "Stardew Valley",
    steamAppId: "413150",
    steamDir: "Stardew Valley",
    executable: "Stardew Valley.exe",
  },
};

export class GameNotFoundError extends Error {}

/**
 * Every Steam library root on this machine, read from libraryfolders.vdf.
 *
 * Parsed with a regex rather than a full VDF parser: the only thing needed is
 * the `"path"` values, and pulling in a VDF dependency to read one key would be
 * disproportionate. A malformed file yields no roots, which surfaces as a clear
 * "not found" rather than a parse crash.
 */
export function steamLibraryRoots(): string[] {
  const steamRoots = [
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Steam"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Steam"),
  ].filter((p) => fs.existsSync(p));

  const roots = new Set<string>(steamRoots);
  for (const steamRoot of steamRoots) {
    const vdf = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(vdf)) continue;
    const content = fs.readFileSync(vdf, "utf8");
    for (const match of content.matchAll(/"path"\s+"([^"]+)"/g)) {
      // VDF escapes backslashes.
      const value = match[1];
      if (value !== undefined) roots.add(value.replace(/\\\\/g, "\\"));
    }
  }
  return [...roots];
}

/** Locate a known game's install directory, or undefined when it isn't installed. */
export function findGamePath(game: GameDefinition): string | undefined {
  if (game.steamDir === undefined) return undefined;

  for (const root of steamLibraryRoots()) {
    // Require the appmanifest as well as the directory: Steam leaves the
    // `common/<Game>` folder behind after an uninstall often enough that the
    // directory alone is not evidence the game is actually installed. That is
    // exactly what happened with Skyrim SE on the machine this was built on.
    if (game.steamAppId !== undefined) {
      const manifest = path.join(root, "steamapps", `appmanifest_${game.steamAppId}.acf`);
      if (!fs.existsSync(manifest)) continue;
    }
    const candidate = path.join(root, "steamapps", "common", game.steamDir);
    if (fs.existsSync(path.join(candidate, game.executable))) return candidate;
  }
  return undefined;
}

export interface EnsureGameOptions {
  /** Explicit install path, skipping discovery entirely. */
  gamePath?: string;
  /** Make this the active game after registering it. Defaults to true. */
  activate?: boolean;
  /** Needed for the CDP-backed real hover in the first-time manage flow. */
  config: HarnessConfig;
}

export interface EnsureGameResult {
  gameId: string;
  gamePath: string;
  activated: boolean;
  alreadyKnown: boolean;
}

/**
 * Register a game's install path with Vortex and activate it.
 *
 * `ADD_DISCOVERED_GAME` is dispatched raw (`type:` prefix) because it is defined
 * inside the gamemode_management extension and is not re-exported through
 * `@nexusmods/vortex-api` — so no action creator exists for vortex_dispatch to
 * find by name.
 */
export async function ensureGameManaged(
  mcp: VortexMcpClient,
  gameId: string,
  options: EnsureGameOptions,
): Promise<EnsureGameResult> {
  const redirect = options.config.profileRedirect;
  if (redirect !== undefined) {
    // Checked before the game is registered or activated: both write to its per-user
    // folders, and for the fake Fallout 4 those must be the sandbox's.
    const status = await mcp.call<{
      paths?: { documents: string | null; localAppData: string | null };
    }>("automation_status");
    assertRedirected(redirect, status.paths);
  }

  const game = KNOWN_GAMES[gameId];
  if (
    options.gamePath !== undefined &&
    (!fs.existsSync(options.gamePath) ||
      (game !== undefined && !fs.existsSync(path.join(options.gamePath, game.executable))))
  ) {
    throw new GameNotFoundError(
      `Invalid explicit game path: ${options.gamePath}. Correct it or use --sandbox; an explicit path never falls back to your installed game.`,
    );
  }

  const existing = await mcp.call<{ path?: string } | null>("vortex_query", {
    path: ["settings", "gameMode", "discovered", gameId],
  });
  const alreadyKnown = existing?.path !== undefined && fs.existsSync(existing.path);

  let gamePath = options.gamePath ?? existing?.path;
  if (gamePath === undefined || !fs.existsSync(gamePath)) {
    if (game === undefined) {
      throw new GameNotFoundError(
        `No install path known for "${gameId}" and it is not one of the games the harness can ` +
          `locate itself (${Object.keys(KNOWN_GAMES).join(", ")}). Pass an explicit path.`,
      );
    }
    gamePath = findGamePath(game);
    if (gamePath === undefined) {
      throw new GameNotFoundError(
        `${game.name} does not appear to be installed — no Steam appmanifest ` +
          `(appmanifest_${game.steamAppId ?? "?"}.acf) plus ${game.executable} in any Steam ` +
          `library on this machine. Install it, or pass an explicit --game-path.`,
      );
    }
  }

  if (!alreadyKnown || existing?.path !== gamePath) {
    await mcp.call("vortex_dispatch", {
      action: "type:ADD_DISCOVERED_GAME",
      args: [
        {
          id: gameId,
          result: {
            path: gamePath,
            pathSetManually: true,
            store: "steam",
            // "Found at" rather than "last seen" — matches the field's own contract.
            timestamp: Date.now(),
          },
        },
      ],
    });
  }

  let activated = false;
  if (options.activate !== false) {
    // activate-game has no dispatchable-action equivalent; it is an internal
    // event, and this is the same path Vortex's own UI uses (SpineContext,
    // QuickLauncher).
    //
    // Fire-and-forget, then poll. Vortex's handler is `on("activate-game",
    // (gameId) => ...)` — it takes NO callback, so passing vortex_dispatch's
    // "__CALLBACK__" sentinel waits forever for something that never fires.
    // The activation is also genuinely asynchronous (it sets up the profile and
    // can deploy), so returning the moment the event is emitted would hand back
    // a game that is not active yet.
    activated = await activateGame(mcp, options.config, gameId, game?.name ?? gameId);
  }

  return { gameId, gamePath, activated, alreadyKnown };
}

/**
 * Make a game active, creating its profile if it does not have one yet.
 *
 * Two different paths, because Vortex treats them differently:
 *
 * - **Already has a profile** — emitting `activate-game` is enough, and it is
 *   the same event Vortex's own spine and quick-launcher emit.
 * - **No profile yet** — `activate-game` is a dead end. Its handler calls
 *   `activateGame`, which on finding no profile for the game opens a "Choose
 *   profile" dialog whose choice list is *empty*, so nothing can ever answer it
 *   and activation hangs forever. The function that creates a first profile
 *   (`manageGameDiscovered`) is not exposed through registerAPI — only
 *   `unmanageGame` is — so there is no API-level way to reach it.
 *
 * The second case therefore goes through the UI, clicking the same "Manage"
 * button a user would. That is not a workaround so much as the actual supported
 * entry point: it also initialises and tags the staging directory, which a
 * hand-rolled `setProfile` dispatch would skip and only fail on much later,
 * at the first mod install.
 */
async function activateGame(
  mcp: VortexMcpClient,
  config: HarnessConfig,
  gameId: string,
  gameName: string,
): Promise<boolean> {
  const profiles = await mcp.call<Record<string, { gameId?: string }> | null>("vortex_query", {
    path: ["persistent", "profiles"],
  });
  const hasProfile = Object.values(profiles ?? {}).some((p) => p.gameId === gameId);

  // Answer blocking modals for the whole activation, not at one fixed point:
  // the purge prompt in particular appears partway through, and without an
  // answer activation simply never completes.
  const controller = new AbortController();
  const answering = autoAnswerDialogs(mcp, {
    signal: controller.signal,
    onAnswer: (a: AnsweredDialog) =>
      console.log(`  answered "${a.dialog.slice(0, 60)}..." with "${a.clicked}" — ${a.because}`),
  });

  try {
    if (hasProfile) {
      await mcp.call("vortex_dispatch", { action: "activate-game", args: [gameId] });
    } else {
      await withUiLock(mcp, () => manageGameViaUi(mcp, config, gameName));
    }
    return await waitForActiveGame(mcp, gameId);
  } finally {
    controller.abort();
    await answering.catch(() => undefined);
  }
}

/**
 * Click through the Games page to manage a game for the first time.
 *
 * Mirrors packages/e2e's own games helper. The search box is not optional: the
 * unmanaged list is windowed, so a game's row is simply not in the DOM until the
 * list has been narrowed to it, and the "Manage" button only renders on hover.
 */
async function manageGameViaUi(
  mcp: VortexMcpClient,
  config: HarnessConfig,
  gameName: string,
): Promise<void> {
  if (!(await tryClick(mcp, ['button[aria-label="Games"]']))) {
    await clickByName(mcp, { role: "button", name: "Games" }).catch(async () => {
      await clickByName(mcp, { role: "link", name: "Games" });
    });
  }

  // The unmanaged list is windowed and 600+ games long, so a game's tile is
  // simply not in the DOM until the list has been narrowed to it.
  const search = await waitForSearchBox(mcp);
  await mcp.call("ui_fill", { ref: search.ref, value: gameName });
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  // Reveal the tile's actions with a REAL hover.
  //
  // Vortex hides them in a wrapper at `opacity: 0`, revealed by a CSS `:hover`
  // rule. `ui_hover` dispatches DOM events, which run React handlers but never
  // change the browser's own hover state — so the button stays transparent and
  // the snapshot correctly reports it hidden. Only a real mouse move, which is
  // CDP-only, does it.
  //
  // The markup differs between Vortex versions, so try the specific class first
  // and fall back to anything game-ish wrapping this game's artwork. Matching on
  // the image's alt text is what keeps "Fallout 4" from hitting "Fallout 4 VR".
  const tile = await realHoverFirst(config, [
    `.game-thumbnail:has(img[alt="${gameName}"])`,
    `.game-list-item:has(img[alt="${gameName}"])`,
    `[class*="game"]:has(> img[alt="${gameName}"])`,
    `[class*="game"]:has(img[alt="${gameName}"])`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 800));

  // Prefer Vortex's own stable class over the label, which moves between
  // versions ("Manage" on 2.6.x, "Add game" on newer layouts).
  const clicked = await tryClick(mcp, [
    ...(tile === undefined ? [] : [`${tile} button.action-manage`]),
    "button.action-manage",
  ]);

  if (!clicked) {
    const manage = await waitForNode(mcp, { role: "button", name: /^(manage|add game)$/i }, 15_000);
    await mcp.call("ui_click", { ref: manage.ref });
  }

  // "Game not discovered" should not appear — the path was registered before
  // this ran — but a stale discovery entry can still produce it, and leaving it
  // open would block everything after.
  const dialog = await snapshot(mcp);
  if (dialog.activeDialogs.some((d) => /not.*discovered/i.test(d))) {
    const cont = findNodes(dialog, { role: "button", name: "Continue" })[0];
    if (cont !== undefined) await mcp.call("ui_click", { ref: cont.ref });
  }
}

/** Real-hover the first selector that matches, returning it. */
async function realHoverFirst(
  config: HarnessConfig,
  selectors: string[],
): Promise<string | undefined> {
  for (const selector of selectors) {
    try {
      await realHover(config, selector, { timeoutMs: 4_000 });
      return selector;
    } catch {
      // Try the next shape of markup.
    }
  }
  return undefined;
}

/** Click the first selector that resolves; false when none do. */
async function tryClick(mcp: VortexMcpClient, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const ok = await mcp
      .call("ui_click", { selector })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

/** The games filter box, by test id where available and by role otherwise. */
async function waitForSearchBox(mcp: VortexMcpClient): Promise<{ ref: string }> {
  const started = Date.now();
  for (;;) {
    const snap = await snapshot(mcp);
    const box =
      findNodes(snap, { testId: "search-input" })[0] ??
      findNodes(snap, { role: "searchbox" })[0] ??
      findNodes(snap, { role: "textbox", name: /search/i })[0];
    if (box !== undefined) return box;
    if (Date.now() - started > 30_000) {
      throw new GameNotFoundError("The games page never showed its search box.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Poll until Vortex reports the given game as active. */
async function waitForActiveGame(
  mcp: VortexMcpClient,
  gameId: string,
  timeoutMs = 180_000,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const active = await mcp
      .call<string | null>("vortex_query", { selector: "activeGameId" })
      .catch(() => null);
    if (active === gameId) return true;
    if (Date.now() - started > timeoutMs) {
      // Activation stalls almost exclusively on something Vortex is waiting for
      // a human to answer, so report what that is rather than making the caller
      // go and find the instance log.
      const [dialogs, notifications, onScreen] = await Promise.all([
        mcp.call<unknown>("list_dialogs").catch(() => "unavailable"),
        mcp.call<unknown>("list_notifications").catch(() => "unavailable"),
        mcp
          .call<{ activeDialogs: string[] }>("ui_snapshot", { maxNodes: 1 })
          .then((s) => s.activeDialogs)
          .catch(() => []),
      ]);
      throw new GameNotFoundError(
        `Vortex did not make "${gameId}" the active game within ` +
          `${String(Math.round(timeoutMs / 1000))}s (still "${String(active)}").
` +
          `  On-screen modals: ${JSON.stringify(onScreen).slice(0, 600)}
` +
          `  Dialogs:       ${JSON.stringify(dialogs).slice(0, 600)}
` +
          `  Notifications: ${JSON.stringify(notifications).slice(0, 800)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
