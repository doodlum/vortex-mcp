/**
 * Configuration, paths, and locating Vortex itself.
 *
 * Everything an operator has to supply lives here, in one place, so `doctor` can
 * check it and AGENTS.md can document it without either drifting from the code.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const HARNESS_ROOT = path.resolve(import.meta.dirname, "..");
/** The vortex-mcp checkout — this repo. */
export const REPO_ROOT = path.resolve(HARNESS_ROOT, "..");

// Loaded from harness/.env when present, so an operator can keep the API key out
// of their shell profile. Gitignored.
const envFile = path.join(HARNESS_ROOT, ".env");
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * How the harness starts Vortex.
 *
 * `installed` is the default and the one that matters: it drives a stock,
 * officially released Vortex, with no patched build and no source checkout. The
 * extension is written to that constraint deliberately.
 *
 * `dev` points Electron at a Vortex source checkout instead. The only thing it
 * buys is hot-reloading changes to *Vortex's own* renderer code; everything else
 * behaves identically.
 */
export type VortexTargetKind = "installed" | "dev";

export interface VortexTarget {
  kind: VortexTargetKind;
  /** Executable to run. */
  executable: string;
  /** Extra argv before the debugging flags (the app directory, for `dev`). */
  args: string[];
  /**
   * Subdirectory of appData that Vortex expects to find startup.json in.
   *
   * It is Electron's app name, which differs between builds: a released Vortex
   * is `Vortex`, while a source checkout takes it from src/main/package.json and
   * so is `@vortex/main`. Creating the wrong one makes Vortex quit during
   * startup with an unrecoverable ENOENT on startup.json — which reads like a
   * corrupt profile rather than a naming mismatch.
   */
  appName: string;
  /** Vortex source checkout root, when kind === "dev" — needed for rebuilds. */
  sourceDir?: string;
}

export interface HarnessConfig {
  /**
   * Nexus Mods personal API key. The ONLY thing a human has to provide, and
   * only for Nexus downloads.
   *
   * This is what makes "no user input" login possible: Vortex's `isLoggedIn` is
   * true whenever `confidential.account.nexus.APIKey` is set, so the harness
   * dispatches SET_USER_API_KEY and the app is logged in — no browser, no OAuth
   * redirect, and crucially no captcha.
   */
  apiKey: string | undefined;
  /** Bearer token unlocking vortex-mcp's write tools. Generated if unset. */
  mcpToken: string;
  /** Port vortex-mcp listens on inside the launched Vortex. */
  mcpPort: number;
  /** CDP port opened on the launched Vortex, for screenshots and Playwright. */
  cdpPort: number;
  /** Game to manage during bootstrap. */
  gameId: string;
  /** Explicit install path for that game, instead of locating it via Steam. */
  gamePath: string | undefined;
  /** Where the built extension is staged and seeded profiles cached. */
  cacheDir: string;
  /** Where screenshots and sweep reports are written. */
  artifactDir: string;
  /** How to start Vortex. */
  target: VortexTarget;
  /** Hide the window. Off by default — layout measurement needs a real window. */
  headless: boolean;
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * A stable per-machine token when none is configured.
 *
 * Random-per-run would look more secure but would mean a different
 * `claude mcp add` every time, defeating a documented one-line client setup. The
 * server is loopback-bound and host/origin-validated regardless; the token gates
 * writes, and a stable one in .env is the same trust level as the Vortex UI the
 * operator already has.
 */
function defaultToken(): string {
  return `vortex-ai-${os.hostname().replace(/[^a-zA-Z0-9]/g, "")}`;
}

export class ConfigError extends Error {}

/** Where a released Vortex puts itself, most likely first. */
function installedVortexCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  return [
    path.join(programFiles, "Vortex", "Vortex.exe"),
    path.join(programFiles, "Black Tree Gaming Ltd", "Vortex", "Vortex.exe"),
    localAppData === "" ? "" : path.join(localAppData, "Programs", "Vortex", "Vortex.exe"),
  ].filter((p) => p !== "");
}

/**
 * The Vortex clone this repo manages, at `.vortex-src`, or undefined.
 *
 * Deliberately the only place a source checkout is looked for. The suite never
 * goes hunting around the filesystem for a Vortex repo: "some checkout
 * somewhere" is not something it can reason about, build from, or push to.
 */
function managedSourceDir(): string | undefined {
  const dir = process.env.VORTEX_AI_SOURCE_DIR ?? path.join(REPO_ROOT, ".vortex-src");
  return fs.existsSync(path.join(dir, "src", "main", "package.json")) ? dir : undefined;
}

export function findInstalledVortex(): string | undefined {
  const explicit = process.env.VORTEX_AI_EXE;
  if (explicit !== undefined && explicit !== "" && fs.existsSync(explicit)) return explicit;
  return installedVortexCandidates().find((c) => fs.existsSync(c));
}

/**
 * Resolve how to start Vortex.
 *
 * The extension itself is written to work against a stock released build, and
 * that constraint still holds — but this suite's job is building and testing
 * Vortex, so a clone it manages takes precedence once one exists.
 */
export function resolveTarget(
  overrides: { devDir?: string; exe?: string; preferInstalled?: boolean } = {},
): VortexTarget {
  // Precedence: an explicit --dev-dir, then the clone this repo manages, then an
  // installed Vortex. The clone wins because if you have gone to the trouble of
  // cloning Vortex here, working on it is the whole point — but --installed
  // puts the released build back in front.
  const managed = overrides.preferInstalled === true ? undefined : managedSourceDir();
  const devDir = overrides.devDir ?? process.env.VORTEX_AI_DEV_DIR ?? managed;
  if (devDir !== undefined && devDir !== "") {
    const mainDir = path.join(devDir, "src", "main");
    const resolved = fs.existsSync(mainDir) ? mainDir : devDir;
    return {
      kind: "dev",
      executable: resolveDevElectron(resolved),
      args: [resolved],
      appName: "@vortex/main",
      sourceDir: path.resolve(resolved, "..", ".."),
    };
  }

  const exe = overrides.exe ?? findInstalledVortex();
  if (exe === undefined) {
    throw new ConfigError(`No Vortex to drive.

  Work on Vortex itself:     pnpm run ai:source
     (finds your GitHub fork, clones it into .vortex-src here, and builds it)

  Or drive a released build:  install it from
     https://www.nexusmods.com/about/vortex/

  Or point at one directly:   VORTEX_AI_EXE / VORTEX_AI_DEV_DIR`);
  }
  return { kind: "installed", executable: exe, args: [], appName: "Vortex" };
}

/** Electron binary from a Vortex source checkout — only used by the `dev` target. */
function resolveDevElectron(mainDir: string): string {
  return createRequire(path.join(mainDir, "package.json"))("electron") as string;
}

/**
 * Config loading must not throw just because Vortex is missing — `doctor` exists
 * precisely to report that, and it can report nothing if building the config
 * blew up first.
 */
function resolveTargetSafely(): VortexTarget {
  try {
    return resolveTarget();
  } catch {
    return { kind: "installed", executable: "", args: [], appName: "Vortex" };
  }
}

export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    apiKey: process.env.VORTEX_AI_NEXUS_API_KEY ?? process.env.NEXUS_API_KEY,
    mcpToken: process.env.VORTEX_MCP_TOKEN ?? defaultToken(),
    mcpPort: Number(process.env.VORTEX_MCP_PORT ?? 3701),
    cdpPort: Number(process.env.VORTEX_AI_CDP_PORT ?? 9222),
    gameId: process.env.VORTEX_AI_GAME_ID ?? "fallout4",
    gamePath: process.env.VORTEX_AI_GAME_PATH,
    cacheDir: process.env.VORTEX_AI_CACHE_DIR ?? path.join(HARNESS_ROOT, ".cache"),
    artifactDir: process.env.VORTEX_AI_ARTIFACT_DIR ?? path.join(HARNESS_ROOT, ".artifacts"),
    target: resolveTargetSafely(),
    headless: envFlag("VORTEX_AI_HEADLESS"),
    ...overrides,
  };
}

/** This repo — holds the built extension that gets copied into an instance. */
export function extensionRoot(): string {
  return REPO_ROOT;
}

export const MCP_EXTENSION_ID = "vortex-mcp";

/**
 * The Nexus API key, or a directly actionable error saying how to supply one.
 *
 * Call this **before** starting or connecting to anything, in any operation that
 * touches Nexus. Everything else in this harness works signed out, so the key is
 * checked at the point of need rather than at startup — but at that point it is
 * a hard requirement, and the run should stop here saying what is missing rather
 * than cold-start an instance and fail on a rejected download minutes later.
 *
 * A key cannot be guessed, derived, or read out of an existing Vortex install —
 * it is the user's credential. An agent that hits this asks the user for one and
 * writes it to `harness/.env` once; it is gitignored and reused from then on.
 */
export function requireApiKey(config: HarnessConfig): string {
  if (config.apiKey === undefined || config.apiKey.trim() === "") {
    throw new ConfigError(
      "No Nexus API key configured, and this operation needs one — Nexus downloads " +
        "cannot be made anonymously.\n\n" +
        "  Ask the user for a personal API key; it is theirs to give and cannot be " +
        "obtained any other way.\n\n" +
        "  1. Open https://next.nexusmods.com/settings/api-keys\n" +
        "  2. Copy the personal API key\n" +
        "  3. echo 'VORTEX_AI_NEXUS_API_KEY=<key>' >> harness/.env   # gitignored\n\n" +
        "  Stored once, it is reused by every later run, including cold ones.\n",
    );
  }
  return config.apiKey.trim();
}
