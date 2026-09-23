/**
 * Redirect Electron paths in Vortex's main process before any Vortex code runs.
 *
 * Some writes cannot be redirected with environment variables. `Documents` is a
 * Windows known folder that Electron resolves itself, and a Bethesda game's INI
 * files, INI backups, archive invalidation and per-profile INI copies all live under
 * it. A test against a fake Fallout 4 would otherwise rewrite the operator's real
 * `Documents\My Games\Fallout4`.
 *
 * Node runs `NODE_OPTIONS=--require <file>` before the app's own entry point, and
 * Electron honours NODE_OPTIONS in Vortex's packaged build (its
 * `EnableNodeOptionsEnvironmentVariable` fuse is on in 2.7.0). The preload calls
 * `app.setPath` for each redirected path and records what Electron then reports. The
 * harness checks that record before it lets Vortex go any further.
 *
 * `--inspect-brk` was tried first and is a trap. Node's worker threads inherit the
 * break-on-start option and wait for a debugger that never attaches. Vortex hashes
 * archives in a worker, so every install then hangs, with nothing logged.
 *
 * The preload removes itself from NODE_OPTIONS once loaded, so processes Vortex
 * spawns do not run it again.
 */
import fs from "node:fs";
import path from "node:path";

export interface PreloadRecord {
  pid: number;
  paths: Record<string, string>;
  /** Written as soon as the preload runs, before the paths are applied. */
  loaded?: boolean;
  error?: string;
}

/** The preload's source. Plain CommonJS: it runs before any bundler or loader. */
export function preloadSource(paths: Record<string, string>, recordFile: string): string {
  return `"use strict";
// Written by vortex-mcp's harness; see harness/src/mainPreload.ts.
const fs = require("fs");
const Module = require("module");
const recordFile = ${JSON.stringify(recordFile)};
const record = (value) => fs.writeFileSync(recordFile, JSON.stringify(value));
const wanted = ${JSON.stringify(paths)};

// Only Electron's main process ("browser") can set paths. Renderers and Node helpers
// inherit NODE_OPTIONS and load this too; they must leave everything alone.
if (process.type === "browser") {
  record({ pid: process.pid, paths: {}, loaded: true });
  // The built-in electron module does not exist yet while a --require preload runs, so
  // apply the paths the first time the app itself loads it — which is before any Vortex
  // code can have read them.
  const originalLoad = Module._load;
  let done = false;
  Module._load = function (request, ...rest) {
    const loaded = originalLoad.call(this, request, ...rest);
    if (!done && request === "electron" && loaded && loaded.app && typeof loaded.app.setPath === "function") {
      done = true;
      Module._load = originalLoad;
      try {
        for (const [name, value] of Object.entries(wanted)) loaded.app.setPath(name, value);
        record({
          pid: process.pid,
          paths: Object.fromEntries(Object.keys(wanted).map((name) => [name, loaded.app.getPath(name)])),
        });
      } catch (err) {
        record({ pid: process.pid, paths: {}, error: String((err && err.stack) || err) });
        // Fail closed: a Vortex with the real paths must not start.
        process.exit(78);
      }
    }
    return loaded;
  };
  // Processes Vortex spawns must not load this again.
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "")
    .replace(/--require\\s+("[^"]*"|\\S+)/g, "")
    .trim();
}
`;
}

export interface PreparedPreload {
  /** The value to put in NODE_OPTIONS. */
  nodeOptions: string;
  /** Where the preload records what Electron reported. */
  recordFile: string;
}

/** Write the preload for an instance directory. */
export function preparePreload(
  instanceDir: string,
  paths: Record<string, string>,
): PreparedPreload {
  const dir = path.join(instanceDir, "harness");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "redirect-paths.cjs");
  const recordFile = path.join(dir, "redirect-paths.json");
  fs.rmSync(recordFile, { force: true });
  fs.writeFileSync(file, preloadSource(paths, recordFile));
  // Forward slashes: NODE_OPTIONS reads backslashes inside quotes as escapes, so a
  // quoted Windows path silently becomes one that does not exist.
  return { nodeOptions: `--require "${file.replace(/\\/g, "/")}"`, recordFile };
}

export class PreloadError extends Error {}

/**
 * Wait for the preload's record and check every path took. The main process writes it
 * on its first line, long before Vortex reaches game activation, so a short wait
 * decides it; no record at all means NODE_OPTIONS was ignored.
 */
export async function verifyPreload(
  recordFile: string,
  paths: Record<string, string>,
  timeoutMs = 15_000,
): Promise<PreloadRecord> {
  const deadline = Date.now() + timeoutMs;
  let loaded = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(recordFile)) {
      let record: PreloadRecord;
      try {
        record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as PreloadRecord;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (record.loaded === true) {
        // Running, but Vortex has not loaded electron yet.
        loaded = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (record.error !== undefined) {
        throw new PreloadError(`Redirecting Vortex's paths failed: ${record.error}`);
      }
      for (const [name, wanted] of Object.entries(paths)) {
        if (record.paths[name]?.toLowerCase() !== wanted.toLowerCase()) {
          throw new PreloadError(
            `Electron's ${name} path is ${String(record.paths[name])}, not ${wanted}.`,
          );
        }
      }
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (loaded) {
    throw new PreloadError(
      "The path-redirect preload ran but Vortex never loaded electron through Node's module " +
        "loader, so its paths could not be set.",
    );
  }
  throw new PreloadError(
    "Vortex started without running the path-redirect preload; this build ignores " +
      "NODE_OPTIONS, so its Documents folder cannot be isolated. Released (packaged) builds " +
      "do; use a source build (`--dev-dir <checkout>`), for instance one checked out at the " +
      "release tag.",
  );
}
