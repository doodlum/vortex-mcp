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

export function findInstalledVortex(): string | undefined {
  const explicit = process.env.VORTEX_AI_EXE;
  if (explicit !== undefined && explicit !== "" && fs.existsSync(explicit)) return explicit;
  return installedVortexCandidates().find((c) => fs.existsSync(c));
}

/**
 * Resolve how to start Vortex, preferring a real installation.
 *
 * A source checkout is used only when explicitly pointed at, because running
 * against the released build is the case that proves the extension needs no
 * patched Vortex.
 */
export function resolveTarget(overrides: { devDir?: string; exe?: string } = {}): VortexTarget {
  const devDir = overrides.devDir ?? process.env.VORTEX_AI_DEV_DIR;
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
    throw new ConfigError(
      "Could not find an installed Vortex.\n\n" +
        "  Install it from https://www.nexusmods.com/about/vortex/ — the harness drives the\n" +
        "  released build and needs no patched or self-built copy.\n\n" +
        "  Installed somewhere unusual? Set VORTEX_AI_EXE to its Vortex.exe.\n" +
        "  Working on Vortex itself? Point VORTEX_AI_DEV_DIR at your checkout instead.",
    );
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

/** Throw a directly actionable error when the one optional secret is missing. */
export function requireApiKey(config: HarnessConfig): string {
  if (config.apiKey === undefined || config.apiKey.trim() === "") {
    throw new ConfigError(
      "No Nexus API key configured. It is only needed for Nexus downloads; everything else " +
        "works signed out.\n\n" +
        "  1. Open https://next.nexusmods.com/settings/api-keys\n" +
        "  2. Copy your personal API key\n" +
        "  3. echo 'VORTEX_AI_NEXUS_API_KEY=<key>' >> harness/.env\n",
    );
  }
  return config.apiKey.trim();
}
