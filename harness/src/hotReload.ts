/**
 * Hot-reloading changes into a running Vortex without restarting it.
 *
 * What counts as "a change" depends on what you are working on, so there are two
 * modes and the harness picks by target:
 *
 * - **extension** (default, and the only option against an installed Vortex).
 *   Watches this repo's `dist/`, reinstalls the built extension into the live
 *   instance, and reloads the renderer. `location.reload()` re-runs extension
 *   initialisation, so the new code is live — this is the tight loop for
 *   developing the MCP tools themselves.
 * - **renderer** (`dev` target only). Also watches Vortex's own renderer bundle,
 *   for when you are changing Vortex's UI rather than the extension.
 *
 * Neither mode owns the build. They watch *output*, so they compose with
 * whatever produced it — `pnpm run dev` (tsup --watch), a one-off `pnpm run
 * build`, or webpack's watch in a Vortex checkout. Owning the build instead
 * would mean a second builder racing the first over the same output directory.
 *
 * A change to Vortex's MAIN process can never be hot-reloaded — nothing in the
 * renderer can reload main — so that is reported explicitly rather than
 * reloading and appearing to do nothing.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { extensionRoot, type HarnessConfig } from "./config";
import { installMcpExtension } from "./instance";
import type { VortexMcpClient } from "./mcpClient";

const execFileAsync = promisify(execFile);

/** Built extension artifacts — a change here means the tools themselves changed. */
export function extensionArtifacts(): string[] {
  return [path.join(extensionRoot(), "dist", "index.js")];
}

/** Vortex's own renderer output. Only meaningful for a `dev` target. */
export function rendererArtifacts(config: HarnessConfig): string[] {
  const source = config.target.sourceDir;
  if (config.target.kind !== "dev" || source === undefined) return [];
  const build = path.join(source, "src", "main", "build");
  return [path.join(build, "renderer.js"), path.join(build, "assets", "css", "tailwind-v4.css")];
}

/** Vortex main-process output — a change here cannot be hot-reloaded. */
export function mainArtifacts(config: HarnessConfig): string[] {
  const source = config.target.sourceDir;
  if (config.target.kind !== "dev" || source === undefined) return [];
  return [path.join(source, "src", "main", "build", "main.cjs")];
}

interface Fingerprint {
  [file: string]: number;
}

function fingerprintOf(files: string[]): Fingerprint {
  const out: Fingerprint = {};
  for (const file of files) {
    try {
      out[file] = fs.statSync(file).mtimeMs;
    } catch {
      out[file] = 0;
    }
  }
  return out;
}

function changed(before: Fingerprint, after: Fingerprint): string[] {
  return Object.keys(after).filter((f) => before[f] !== after[f]);
}

/** Rebuild the extension once. */
export async function buildExtension(): Promise<void> {
  await execFileAsync("pnpm", ["run", "build"], {
    cwd: extensionRoot(),
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export interface WatchOptions {
  /** The live instance directory to reinstall the extension into. */
  liveDir: string;
  /** Run a build ourselves on each change instead of only reacting to one. */
  build?: boolean;
  /** Poll interval for the output fingerprint. */
  pollMs?: number;
  /**
   * Quiet period after a change before reloading. A build writes several files;
   * reloading on the first would reload against a half-written bundle.
   */
  debounceMs?: number;
  onEvent?: (event: HotReloadEvent) => void;
  signal?: AbortSignal;
}

export type HotReloadEvent =
  | { type: "watching"; extension: string[]; renderer: string[] }
  | { type: "changed"; what: "extension" | "renderer"; files: string[] }
  | { type: "building" }
  | { type: "reloaded"; elapsedMs: number }
  | { type: "main-changed"; files: string[] }
  | { type: "error"; message: string };

/**
 * Watch build output and reload the running instance whenever it changes.
 *
 * Polls mtimes rather than using fs.watch: bundlers replace output by rename on
 * some platforms, which invalidates an fs.watch handle on the old inode and
 * silently stops delivering events — the watcher appears to work and then just
 * never fires again.
 */
export async function watchAndReload(
  mcp: VortexMcpClient,
  config: HarnessConfig,
  options: WatchOptions,
): Promise<void> {
  const pollMs = options.pollMs ?? 400;
  const debounceMs = options.debounceMs ?? 600;
  const emit = options.onEvent ?? ((): void => undefined);

  const extFiles = extensionArtifacts();
  const rendererFiles = rendererArtifacts(config);
  const mainFiles = mainArtifacts(config);
  emit({ type: "watching", extension: extFiles, renderer: rendererFiles });

  let extPrint = fingerprintOf(extFiles);
  let rendererPrint = fingerprintOf(rendererFiles);
  let mainPrint = fingerprintOf(mainFiles);

  const aborted = (): boolean => options.signal?.aborted === true;

  while (!aborted()) {
    await sleep(pollMs, options.signal);
    if (aborted()) break;

    if (mainFiles.length > 0) {
      const nextMain = fingerprintOf(mainFiles);
      const mainChanged = changed(mainPrint, nextMain);
      if (mainChanged.length > 0) {
        mainPrint = nextMain;
        emit({ type: "main-changed", files: mainChanged });
      }
    }

    const nextExt = fingerprintOf(extFiles);
    const nextRenderer = fingerprintOf(rendererFiles);
    const extChanged = changed(extPrint, nextExt);
    const rendererChanged = changed(rendererPrint, nextRenderer);
    if (extChanged.length === 0 && rendererChanged.length === 0) continue;

    emit({
      type: "changed",
      what: extChanged.length > 0 ? "extension" : "renderer",
      files: [...extChanged, ...rendererChanged],
    });

    // Settle: keep waiting while the fingerprints are still moving, so a
    // multi-file build produces one reload rather than several.
    let settledExt = nextExt;
    let settledRenderer = nextRenderer;
    for (;;) {
      await sleep(debounceMs, options.signal);
      const againExt = fingerprintOf(extFiles);
      const againRenderer = fingerprintOf(rendererFiles);
      if (
        changed(settledExt, againExt).length === 0 &&
        changed(settledRenderer, againRenderer).length === 0
      ) {
        break;
      }
      settledExt = againExt;
      settledRenderer = againRenderer;
    }
    extPrint = settledExt;
    rendererPrint = settledRenderer;

    const started = Date.now();
    try {
      if (options.build === true) {
        emit({ type: "building" });
        await buildExtension();
        extPrint = fingerprintOf(extFiles);
      }

      // Copy the rebuilt extension in before reloading, or the reload picks up
      // the previous build and the change appears not to have taken.
      if (extChanged.length > 0 || options.build === true) {
        installMcpExtension(options.liveDir);
      }

      await mcp.call("ui_reload_renderer");
      // The renderer tears down and comes back; wait for MCP to answer again
      // before reporting success, or the next command races the reload.
      await mcp.waitUntilReady(60_000);
      emit({ type: "reloaded", elapsedMs: Date.now() - started });
    } catch (err) {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
