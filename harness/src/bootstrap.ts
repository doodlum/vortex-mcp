/**
 * Getting from nothing to a logged-in, game-managed Vortex as fast as possible.
 *
 * Three tiers, in descending cost:
 *
 *   cold   no cache yet. Launch a blank instance, seed the API key and the game
 *          path over MCP, quit cleanly, and snapshot the resulting user-data
 *          directory. Paid once per machine per (key, game) pair.
 *   warm   a live working directory already exists. Just launch it. No copying,
 *          so a previous run's installed mods are still there.
 *   reset  cache exists but the working directory is stale or unwanted. Copy the
 *          snapshot over it — a few hundred KB, effectively instant — and launch.
 *
 * Why snapshot rather than write Vortex's state database directly: persistence
 * is DuckDB with a `level_pivot` extension, keyed `hive###path###parts`. Seeding
 * that by hand would mean reimplementing a storage format that is version-
 * coupled to Vortex and can change without notice. Letting Vortex write its own
 * state once and copying the result is slower to produce but cannot silently
 * desynchronise from the app.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MCP_EXTENSION_ID, type HarnessConfig } from "./config";
import { ensureGameManaged, type EnsureGameResult } from "./gameSetup";
import {
  ensureExtensionBuilt,
  installMcpExtension,
  launchVortex,
  prepareUserDataDir,
  removeInstanceDir,
  stopStaleInstance,
  type VortexInstance,
} from "./instance";
import type { VortexMcpClient } from "./mcpClient";

/**
 * Bumped when a change here makes previously-cached snapshots wrong (a different
 * seeding step, a new required piece of state). Cheaper and more reliable than
 * trying to detect staleness from the snapshot's contents.
 */
const SNAPSHOT_SCHEMA_VERSION = 1;

const MARKER_FILE = ".vortex-ai-snapshot.json";

export interface SnapshotMarker {
  schemaVersion: number;
  gameId: string;
  gamePath: string;
  createdAt: string;
  /** Fingerprint of the API key — never the key itself. */
  apiKeyFingerprint: string;
}

function fingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Anonymous instances are a first-class case, not a degraded one.
 *
 * Everything except Nexus downloads — driving the UI, managing a game,
 * installing a local archive, deploying, responsive testing — works with no
 * account at all. Requiring a key up front would mean nobody could try the
 * harness without first going to get one.
 */
export const ANONYMOUS = "anonymous";

export function snapshotDir(config: HarnessConfig, apiKey: string): string {
  // The target is part of the key because the two builds are not
  // interchangeable: a released Vortex keeps startup.json under appData/Vortex
  // and a source checkout under appData/@vortex/main, so reusing one build's
  // snapshot for the other makes Vortex quit on a missing startup.json.
  const key = fingerprint(
    `${String(SNAPSHOT_SCHEMA_VERSION)}:${apiKey}:${config.gameId}:${config.gamePath ?? "auto"}:` +
      `${config.target.kind}:${config.target.appName}`,
  );
  return path.join(config.cacheDir, `snapshot-${key}`);
}

export function liveDir(config: HarnessConfig): string {
  return path.join(config.cacheDir, "live");
}

export function readMarker(dir: string): SnapshotMarker | undefined {
  const file = path.join(dir, MARKER_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotMarker;
  } catch {
    return undefined;
  }
}

function isUsableSnapshot(dir: string, apiKey: string, gameId: string): boolean {
  const marker = readMarker(dir);
  return (
    marker !== undefined &&
    marker.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
    marker.gameId === gameId &&
    marker.apiKeyFingerprint === fingerprint(apiKey) &&
    // A game that has since been uninstalled would make every later step fail
    // in a confusing place; catch it while there is still a clear thing to say.
    fs.existsSync(marker.gamePath)
  );
}

/**
 * Log in without any user interaction.
 *
 * Vortex's `isLoggedIn` selector is `truthy(APIKey) || truthy(OAuthCredentials)`,
 * so setting the API key is a complete login as far as the app is concerned —
 * no browser, no OAuth redirect, and no captcha. The captcha is precisely what
 * forces the E2E suite's `auth:capture` to be a manual one-off, and why that
 * approach could never satisfy "from scratch with no user input".
 *
 * Dispatched raw because SET_USER_API_KEY is defined inside the
 * nexus_integration extension and is not re-exported through vortex-api.
 */
export async function seedLogin(mcp: VortexMcpClient, apiKey: string): Promise<void> {
  await mcp.call("vortex_dispatch", { action: "type:SET_USER_API_KEY", args: [apiKey] });

  const loggedIn = await mcp.call<boolean>("vortex_query", { selector: "isLoggedIn" });
  if (loggedIn !== true) {
    throw new Error(
      "Dispatched the API key but Vortex still reports isLoggedIn=false. The key may be " +
        "malformed — check it at https://next.nexusmods.com/settings/api-keys.",
    );
  }
}

export interface BootstrapOptions {
  /** Discard the live working directory and re-seed it from the snapshot. */
  fresh?: boolean;
  /** Rebuild the snapshot from cold even if a usable one exists. */
  rebuildSnapshot?: boolean;
  /** Rebuild the extension from source first. */
  rebuildExtension?: boolean;
  /**
   * Skip managing/activating a game. Useful for driving Vortex's global UI
   * (settings, extensions, the dashboard) and for diagnosing a game-setup
   * failure with the instance still up.
   */
  skipGame?: boolean;
  /** Progress reporting. */
  onProgress?: (message: string) => void;
}

export interface BootstrapResult {
  instance: VortexInstance;
  tier: "cold" | "warm" | "reset";
  game: EnsureGameResult;
  elapsedMs: number;
}

/**
 * Bring up a ready-to-drive Vortex, building whatever tier of cache is missing.
 *
 * Always returns a *running* instance whose MCP server has answered, is logged
 * in, and has the target game active.
 */
export async function bootstrap(
  config: HarnessConfig,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const started = Date.now();
  const report = options.onProgress ?? ((): void => undefined);
  const configuredKey = config.apiKey?.trim();
  const apiKey = configuredKey !== undefined && configuredKey !== "" ? configuredKey : ANONYMOUS;
  if (apiKey === ANONYMOUS) {
    report(
      "no API key set — starting signed out. Everything except Nexus downloads works; " +
        "see AGENTS.md to enable them.",
    );
  }

  fs.mkdirSync(config.cacheDir, { recursive: true });

  // An instance left over from an earlier run holds both the MCP port and the
  // working directory; every later step would fail on that rather than on
  // anything to do with what was asked for.
  if (await stopStaleInstance(config)) {
    report("stopped a Vortex instance left over from an earlier run");
  }

  const builtAt = await ensureExtensionBuilt({ rebuild: options.rebuildExtension });
  report(`extension ready (${builtAt})`);
  report(`target: ${config.target.kind} — ${config.target.executable}`);

  const snapshot = snapshotDir(config, apiKey);
  const live = liveDir(config);

  if (options.rebuildSnapshot === true && fs.existsSync(snapshot)) {
    removeInstanceDir(snapshot);
  }

  if (!isUsableSnapshot(snapshot, apiKey, config.gameId)) {
    report("no usable snapshot — running a cold bootstrap (this happens once)");
    await buildSnapshot(config, apiKey, snapshot, options);
    // The live dir was produced from an older snapshot; it must not survive.
    removeInstanceDir(live);
  }

  const liveUsable = fs.existsSync(path.join(live, "userData")) && options.fresh !== true;
  const tier: BootstrapResult["tier"] = liveUsable
    ? "warm"
    : isUsableSnapshot(snapshot, apiKey, config.gameId) && fs.existsSync(live)
      ? "reset"
      : "reset";

  if (!liveUsable) {
    report("seeding the working directory from the snapshot");
    removeInstanceDir(live);
    fs.cpSync(snapshot, live, { recursive: true });
  }

  // Both are idempotent, and both matter on the warm path, which does not go
  // through buildSnapshot: the extension is the thing most likely to have been
  // rebuilt since the snapshot was taken, and the appData layout must exist
  // before Vortex starts.
  prepareUserDataDir(live, config.target.appName);
  installMcpExtension(live);

  report(`launching Vortex (${tier})`);
  const instance = await launchVortex({ userDataDir: live, config });

  // Re-assert both on every start. Cheap, and it turns "the snapshot was subtly
  // wrong" into a self-healing case rather than a mysterious failure later.
  if (apiKey !== ANONYMOUS) await seedLogin(instance.mcp, apiKey);

  const game =
    options.skipGame === true
      ? { gameId: config.gameId, gamePath: "(skipped)", activated: false, alreadyKnown: false }
      : await ensureGameManaged(instance.mcp, config.gameId, { gamePath: config.gamePath, config });
  report(
    options.skipGame === true
      ? "skipped game setup (--no-game)"
      : `active game: ${game.gameId} (${game.gamePath})`,
  );

  return { instance, tier: liveUsable ? "warm" : tier, game, elapsedMs: Date.now() - started };
}

/**
 * Cold path: produce a reusable snapshot of a logged-in, game-managed instance.
 *
 * The clean `vortex_quit` at the end is load-bearing. Vortex flushes pending
 * state diffs only on a proper window close; a hard kill here would snapshot a
 * half-written state database, and the damage would not show up until some
 * later warm start behaved oddly.
 */
async function buildSnapshot(
  config: HarnessConfig,
  apiKey: string,
  snapshot: string,
  options: BootstrapOptions,
): Promise<void> {
  const report = options.onProgress ?? ((): void => undefined);

  // Built in place rather than in a staging directory that gets renamed at the
  // end. A directory rename on Windows fails with EPERM for reasons that have
  // nothing to do with Vortex still running — an indexer or scanner holding a
  // transient handle on any descendant is enough, and retrying does not help.
  // Atomicity comes from the marker file instead: it is written last, and
  // isUsableSnapshot requires it, so an interrupted run leaves a markerless
  // directory that is simply treated as absent and rebuilt.
  removeInstanceDir(snapshot);
  prepareUserDataDir(snapshot, config.target.appName);
  installMcpExtension(snapshot);

  report("cold: starting a blank Vortex");
  const instance = await launchVortex({ userDataDir: snapshot, config });

  let game: EnsureGameResult;
  try {
    if (apiKey === ANONYMOUS) {
      report("cold: no API key — skipping login");
    } else {
      report("cold: seeding login from the API key");
      await seedLogin(instance.mcp, apiKey);
    }

    report("cold: registering the game");
    game =
      options.skipGame === true
        ? { gameId: config.gameId, gamePath: "(skipped)", activated: false, alreadyKnown: false }
        : await ensureGameManaged(instance.mcp, config.gameId, {
            gamePath: config.gamePath,
            config,
          });

    report("cold: quitting cleanly to flush state");
  } finally {
    await instance.stop();
  }

  // The extension is reinstalled on every launch anyway, and leaving it out
  // keeps the snapshot small and free of a stale copy.
  fs.rmSync(path.join(snapshot, "userData", "plugins", MCP_EXTENSION_ID), {
    recursive: true,
    force: true,
  });

  // Written last — this is what marks the snapshot complete and usable.
  const marker: SnapshotMarker = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    gameId: game.gameId,
    gamePath: game.gamePath,
    createdAt: new Date().toISOString(),
    apiKeyFingerprint: fingerprint(apiKey),
  };
  fs.writeFileSync(path.join(snapshot, MARKER_FILE), JSON.stringify(marker, null, 2));
  report(`cold: snapshot cached at ${snapshot}`);
}
