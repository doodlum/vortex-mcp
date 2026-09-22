/**
 * Preflight checks.
 *
 * The harness has several independent prerequisites (a built Vortex, a built
 * extension, an API key, an installed game), and when one is missing the
 * downstream failure is usually nowhere near the cause — a missing renderer
 * bundle shows up as "MCP never became ready", which reads like a networking
 * problem. `doctor` exists so the first thing anyone runs tells them which
 * prerequisite is actually missing and the exact command that fixes it.
 */
import fs from "node:fs";
import path from "node:path";

import { readMarker, snapshotDir, liveDir } from "./bootstrap";
import { extensionRoot, findInstalledVortex, type HarnessConfig } from "./config";
import { KNOWN_GAMES, findGamePath, steamLibraryRoots } from "./gameSetup";
import { VortexMcpClient } from "./mcpClient";
import { detectGitHubUser, hasVortexSource, vortexSourceDir } from "./source";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Exact command or step that fixes it. */
  fix?: string;
  /** A failure that does not block the harness (e.g. nothing running yet). */
  advisory?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

export async function runDoctor(config: HarnessConfig): Promise<DoctorReport> {
  const checks: Check[] = [];

  checks.push(checkApiKey(config));
  checks.push(await checkSource());
  checks.push(checkVortex(config));
  checks.push(checkExtension());
  checks.push(checkGame(config));
  checks.push(checkCache(config));
  checks.push(checkCapturedLogin(config));
  checks.push(await checkRunning(config));

  return { ok: checks.every((c) => c.ok || c.advisory === true), checks };
}

function checkCapturedLogin(config: HarnessConfig): Check {
  const key = config.apiKey?.trim();
  const captured =
    readMarker(snapshotDir(config, key === undefined || key === "" ? "anonymous" : key))
      ?.loginCaptured === true;
  return {
    name: "Nexus login captured",
    ok: captured,
    // Advisory for the same reason as the API key: only collections need it,
    // and everything else works without it.
    advisory: true,
    detail: captured
      ? "captured — cold starts come up signed in"
      : "not captured — collections will fail; an API key alone does not cover them",
    fix:
      "Collections use OAuth, and its captcha cannot be automated, so log in once:\n" +
      "      pnpm run ai:up        then click Log in in Vortex\n" +
      "      pnpm run ai -- save-login",
  };
}

function checkApiKey(config: HarnessConfig): Check {
  const set = config.apiKey !== undefined && config.apiKey.trim() !== "";
  return {
    name: "Nexus API key",
    ok: set,
    // Advisory: everything except Nexus downloads works signed out, so a
    // missing key must not read as "the harness is broken".
    advisory: true,
    detail: set
      ? "set (automated login will work with no user input)"
      : "not set — the harness runs signed out; needed only for Nexus downloads/collections",
    fix:
      "Get one at https://next.nexusmods.com/settings/api-keys, then:\n" +
      "      echo 'VORTEX_AI_NEXUS_API_KEY=<key>' >> harness/.env",
  };
}

/**
 * Which Vortex the harness will drive.
 *
 * Reported prominently because it is the single most consequential setting: the
 * whole system is built to work against a released install, and silently
 * falling back to something else would hide the thing worth knowing.
 */
/**
 * The Vortex clone this repo manages.
 *
 * Advisory, not required: you can drive an installed Vortex without ever
 * cloning. But when the task is working ON Vortex, this is the first thing that
 * has to exist, so it is reported before the target.
 */
async function checkSource(): Promise<Check> {
  const dir = vortexSourceDir();
  if (hasVortexSource(dir)) {
    return { name: "Vortex source", ok: true, advisory: true, detail: dir };
  }
  const user = await detectGitHubUser();
  return {
    name: "Vortex source",
    ok: false,
    advisory: true,
    detail:
      user === undefined
        ? "not cloned; could not detect your GitHub user either"
        : `not cloned (would use github.com/${user}/Vortex)`,
    fix: "pnpm run ai:source",
  };
}

function checkVortex(config: HarnessConfig): Check {
  const { target } = config;
  if (target.executable === "" || !fs.existsSync(target.executable)) {
    return {
      name: "Vortex",
      ok: false,
      detail: "no installed Vortex found",
      fix:
        "Install it from https://www.nexusmods.com/about/vortex/ — the released build is " +
        "all this needs. Or set VORTEX_AI_EXE / VORTEX_AI_DEV_DIR.",
    };
  }

  if (target.kind === "dev") {
    const renderer = path.join(target.args[0] ?? "", "build", "renderer.js");
    const built = fs.existsSync(renderer);
    return {
      name: "Vortex (dev checkout)",
      ok: built,
      detail: built
        ? `source build at ${target.sourceDir ?? "?"}`
        : `source checkout at ${target.sourceDir ?? "?"} is not built`,
      fix: "pnpm run ai:source   (installs and builds the clone)",
    };
  }

  return {
    name: "Vortex (installed)",
    ok: true,
    detail: `${target.executable}${findInstalledVortex() === undefined ? " (explicit)" : ""}`,
  };
}

function checkExtension(): Check {
  const source = extensionRoot();
  const built = fs.existsSync(path.join(source, "dist", "index.js"));
  return {
    name: "Extension build",
    ok: true,
    detail: built ? `built (${path.join(source, "dist")})` : "not built yet (builds on demand)",
  };
}

function checkGame(config: HarnessConfig): Check {
  const game = KNOWN_GAMES[config.gameId];
  if (game === undefined) {
    return {
      name: `Game (${config.gameId})`,
      ok: true,
      detail: "not a game the harness can locate itself — pass an explicit path when bootstrapping",
    };
  }
  const found = findGamePath(game);
  return {
    name: `Game (${game.name})`,
    ok: found !== undefined,
    detail: found ?? `not installed — searched Steam libraries: ${steamLibraryRoots().join(", ")}`,
    fix: `Install ${game.name}, or run with --game <id> for one you do have (${Object.keys(KNOWN_GAMES).join(", ")}).`,
  };
}

function checkCache(config: HarnessConfig): Check {
  if (config.apiKey === undefined) {
    return {
      name: "Profile cache",
      ok: true,
      advisory: true,
      detail: "cannot check without an API key",
    };
  }
  const snapshot = snapshotDir(config, config.apiKey.trim());
  const marker = readMarker(snapshot);
  const live = fs.existsSync(path.join(liveDir(config), "userData"));

  return {
    name: "Profile cache",
    ok: true,
    advisory: true,
    detail: live
      ? "live working directory present — next start is warm (fastest)"
      : marker === undefined
        ? "empty — the next start is a cold bootstrap (once, then cached)"
        : `snapshot from ${marker.createdAt} — next start reseeds from it`,
  };
}

async function checkRunning(config: HarnessConfig): Promise<Check> {
  const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
  const running = await mcp.ping();
  if (!running) {
    return {
      name: "Running instance",
      ok: false,
      advisory: true,
      detail: `nothing answering on ${mcp.url}`,
      fix: "pnpm run ai:up",
    };
  }

  const tools = await mcp.listTools().catch(() => []);
  const hasWrite = tools.some((t) => t.name === "ui_click");
  return {
    name: "Running instance",
    ok: true,
    detail: hasWrite
      ? `answering on ${mcp.url} with ${String(tools.length)} tools (writes unlocked)`
      : `answering on ${mcp.url}, but UI write tools are missing — VORTEX_MCP_TOKEN was not set ` +
        `when Vortex was launched, so it is in read-only mode`,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["vortex-ai doctor", ""];
  for (const check of report.checks) {
    const mark = check.ok ? "ok  " : check.advisory === true ? "--  " : "FAIL";
    lines.push(`  [${mark}] ${check.name}`);
    lines.push(`         ${check.detail}`);
    if (!check.ok && check.fix !== undefined) {
      lines.push(`         fix: ${check.fix}`);
    }
  }
  lines.push("");
  lines.push(
    report.ok
      ? "Ready. Start an instance with: pnpm run ai:up"
      : "Not ready — fix the FAIL items above.",
  );
  return lines.join("\n");
}
