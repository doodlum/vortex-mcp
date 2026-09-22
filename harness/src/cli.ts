#!/usr/bin/env -S node --experimental-strip-types
/**
 * `vortex-ai` — the operator-facing entry point to the AI harness.
 *
 * Two audiences, one binary. A human runs `doctor`/`up`/`watch` to get a driven
 * Vortex running; an agent then talks to that instance over MCP and only comes
 * back here for things MCP cannot do (start a process, rebuild a bundle). The
 * one-shot commands (`snapshot`, `click`, `responsive`, ...) exist so the whole
 * thing is usable from a plain shell before any MCP client is wired up — which
 * is also how you tell a broken harness from a broken MCP config.
 */
import fs from "node:fs";
import path from "node:path";

import { bootstrap, liveDir, readMarker, snapshotDir } from "./bootstrap";
import {
  ConfigError,
  loadConfig,
  requireApiKey,
  resolveTarget,
  type HarnessConfig,
} from "./config";
import { runDoctor, formatDoctorReport } from "./doctor";
import { watchAndReload } from "./hotReload";
import { ensureExtensionBuilt } from "./instance";
import { VortexMcpClient } from "./mcpClient";
import { formatReport, runResponsiveSweep } from "./responsive";
import { captureScreenshot } from "./cdp";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const next = rest[i + 1];
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }
  return { command, positional, flags };
}

function configFrom(flags: ParsedArgs["flags"]): HarnessConfig {
  const overrides: Partial<HarnessConfig> = {};
  if (typeof flags.game === "string") overrides.gameId = flags.game;
  if (typeof flags["game-path"] === "string") overrides.gamePath = flags["game-path"];
  if (typeof flags["dev-dir"] === "string" || typeof flags.exe === "string") {
    overrides.target = resolveTarget({
      devDir: typeof flags["dev-dir"] === "string" ? flags["dev-dir"] : undefined,
      exe: typeof flags.exe === "string" ? flags.exe : undefined,
    });
  }
  if (typeof flags.port === "string") overrides.mcpPort = Number(flags.port);
  if (flags.headless === true) overrides.headless = true;
  return loadConfig(overrides);
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** A client for an instance someone else started — the normal case for one-shots. */
function clientFor(config: HarnessConfig): VortexMcpClient {
  return new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
}

async function requireRunning(config: HarnessConfig): Promise<VortexMcpClient> {
  const mcp = clientFor(config);
  if (!(await mcp.ping())) {
    throw new ConfigError(
      `No Vortex instance is answering on ${mcp.url}.\n\n` +
        `Start one first:\n  pnpm run ai:up\n\n` +
        `(or run \`vortex-ai doctor\` to check the setup)`,
    );
  }
  return mcp;
}

const HELP = `vortex-ai — AI/UI automation for Vortex

Drives a stock, officially released Vortex. No patched build required.

Setup
  doctor                 Check everything needed, and say what is missing
  bootstrap              Build the cached, logged-in profile (cold; run once)
    --rebuild-snapshot   Discard the cache and rebuild it from cold
    --rebuild-extension  Rebuild the extension from source first

Running an instance
  up                     Start a ready-to-drive Vortex (logged in, game active)
    --fresh              Reset the working directory from the cached snapshot
    --no-game            Skip managing a game (drive the global UI only)
    --verbose            Pipe Vortex's stdout/stderr through
  down                   Quit the running instance cleanly
  status                 Show cache state and whether an instance is answering

Driving the UI (one-shot; needs a running instance)
  snapshot               Print the accessibility tree of what is on screen
    --selector <css>     Limit to a subtree
  click --ref <e12>      Click an element (or --selector <css>)
  fill --ref <e12> --value <text>
  press --key <Enter>
  screenshot             Save a PNG of the window (captured over CDP)
    --full-page          Capture the whole scrollable page
  tools                  List every MCP tool the instance exposes

Testing
  responsive             Sweep window sizes, report width-dependent issues
    --screenshots        Also save a PNG per size
    --viewports 1024x720,1600x900
    --strict             Exit non-zero when there are width-dependent findings
  watch                  Reload the instance when the extension (or, with
                         --dev-dir, Vortex's renderer) is rebuilt
    --build              Rebuild the extension yourself on each change

Which Vortex
  (default)              The installed, released Vortex
  --exe <path>           A specific Vortex.exe
  --dev-dir <path>       A Vortex source checkout — only needed to hot-reload
                         changes to Vortex's OWN renderer code

Common flags
  --game <id>            Game to manage (default: fallout4)
  --game-path <dir>      Use this install directory instead of locating it via
                         Steam. Use a disposable copy to exercise deploy/purge
                         without touching a real, already-managed game install.
  --port <n>             MCP port (default: 3701)
  --headless             Hide the window (screenshots may be blank)

A Nexus API key is needed only for Nexus downloads. See AGENTS.md.
`;

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.help === true) {
    log(HELP);
    return 0;
  }

  const config = configFrom(flags);

  switch (command) {
    case "doctor": {
      const report = await runDoctor(config);
      log(formatDoctorReport(report));
      return report.ok ? 0 : 1;
    }

    case "bootstrap": {
      const result = await bootstrap(config, {
        rebuildSnapshot: flags["rebuild-snapshot"] === true,
        rebuildExtension: flags["rebuild-extension"] === true,
        fresh: true,
        onProgress: (m) => log(`  ${m}`),
      });
      log(
        `\nReady in ${String(Math.round(result.elapsedMs / 1000))}s (${result.tier}). ` +
          `Game: ${result.game.gameId} at ${result.game.gamePath}`,
      );
      log(`MCP: ${result.instance.mcp.url}`);
      return 0;
    }

    case "up": {
      const result = await bootstrap(config, {
        fresh: flags.fresh === true,
        skipGame: flags["no-game"] === true,
        rebuildExtension: flags["rebuild-extension"] === true,
        onProgress: (m) => log(`  ${m}`),
      });
      log(
        `\nVortex is up in ${String(Math.round(result.elapsedMs / 1000))}s (${result.tier} start).`,
      );
      log(`  MCP:  ${result.instance.mcp.url}`);
      log(`  Game: ${result.game.gameId} (${result.game.gamePath})`);
      log(`\nConnect an agent:`);
      log(
        `  claude mcp add --transport http vortex ${result.instance.mcp.url} ` +
          `-H "Authorization: Bearer ${config.mcpToken}"`,
      );
      // The instance is detached; returning here leaves it running on purpose.
      return 0;
    }

    case "down": {
      const mcp = clientFor(config);
      if (!(await mcp.ping())) {
        log("Nothing is running.");
        return 0;
      }
      await mcp.call("vortex_quit").catch(() => undefined);
      log("Asked Vortex to quit cleanly.");
      return 0;
    }

    case "status": {
      const apiKey = config.apiKey;
      const snapshot = apiKey === undefined ? undefined : snapshotDir(config, apiKey);
      const live = liveDir(config);
      const running = await clientFor(config).ping();

      log(`MCP port ${String(config.mcpPort)}: ${running ? "answering" : "not running"}`);
      log(`Game:     ${config.gameId}`);
      log(`API key:  ${apiKey === undefined ? "NOT SET" : "set"}`);
      if (snapshot !== undefined) {
        const marker = readMarker(snapshot);
        log(
          `Snapshot: ${marker === undefined ? "none (next start is cold)" : `cached ${marker.createdAt}`}`,
        );
      }
      log(
        `Live dir: ${fs.existsSync(path.join(live, "userData")) ? `${live} (warm start)` : "none"}`,
      );
      return 0;
    }

    case "tools": {
      const mcp = await requireRunning(config);
      const tools = await mcp.listTools();
      log(`${String(tools.length)} tools:\n`);
      for (const tool of tools) {
        log(`  ${tool.name.padEnd(28)} ${tool.description.slice(0, 90)}`);
      }
      return 0;
    }

    case "snapshot": {
      const mcp = await requireRunning(config);
      const result = await mcp.call(
        "ui_snapshot",
        typeof flags.selector === "string" ? { selector: flags.selector } : {},
      );
      log(JSON.stringify(result, null, 2));
      return 0;
    }

    case "click": {
      const mcp = await requireRunning(config);
      const result = await mcp.call("ui_click", targetFrom(flags));
      log(JSON.stringify(result, null, 2));
      return 0;
    }

    case "fill": {
      const mcp = await requireRunning(config);
      if (typeof flags.value !== "string") throw new ConfigError("fill needs --value <text>");
      const result = await mcp.call("ui_fill", { ...targetFrom(flags), value: flags.value });
      log(JSON.stringify(result, null, 2));
      return 0;
    }

    case "press": {
      const mcp = await requireRunning(config);
      if (typeof flags.key !== "string") throw new ConfigError("press needs --key <Key>");
      const result = await mcp.call("ui_press_key", { key: flags.key });
      log(JSON.stringify(result, null, 2));
      return 0;
    }

    case "responsive": {
      const mcp = await requireRunning(config);
      const report = await runResponsiveSweep(mcp, config, {
        viewports: parseViewports(flags.viewports),
        screenshots: flags.screenshots === true,
        label: typeof flags.label === "string" ? flags.label : undefined,
      });
      log(formatReport(report));
      return report.regressions.length > 0 && flags.strict === true ? 1 : 0;
    }

    case "watch": {
      const mcp = await requireRunning(config);
      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort());
      log(`Watching for changes (target: ${config.target.kind}). Ctrl-C to stop.`);
      if (config.target.kind === "installed") {
        log("  Extension changes reload live; Vortex's own UI needs --dev-dir.");
      }
      log("");

      await watchAndReload(mcp, config, {
        liveDir: liveDir(config),
        build: flags.build === true,
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case "watching":
              for (const f of [...event.extension, ...event.renderer]) log(`  watching ${f}`);
              log("");
              break;
            case "changed":
              log(`${event.what} changed: ${event.files.map((f) => path.basename(f)).join(", ")}`);
              break;
            case "building":
              log("  rebuilding extension...");
              break;
            case "reloaded":
              log(`  reloaded in ${String(event.elapsedMs)}ms`);
              break;
            case "main-changed":
              log(
                "  Vortex's main-process bundle changed — a renderer reload will NOT pick that " +
                  "up. Restart with `vortex-ai down && vortex-ai up`.",
              );
              break;
            case "error":
              log(`  reload failed: ${event.message}`);
              break;
          }
        },
      });
      return 0;
    }

    case "screenshot": {
      await requireRunning(config);
      const file = await captureScreenshot(config, {
        label: typeof flags.label === "string" ? flags.label : undefined,
        fullPage: flags["full-page"] === true,
      });
      log(file);
      return 0;
    }

    case "build-extension": {
      requireApiKey(config);
      const root = await ensureExtensionBuilt({ rebuild: true });
      log(`Built vortex-mcp at ${root}`);
      return 0;
    }

    default:
      log(`Unknown command "${command}".\n`);
      log(HELP);
      return 1;
  }
}

function targetFrom(flags: ParsedArgs["flags"]): Record<string, unknown> {
  if (typeof flags.ref === "string") return { ref: flags.ref };
  if (typeof flags.selector === "string") return { selector: flags.selector };
  throw new ConfigError("Provide --ref <e12> (from `vortex-ai snapshot`) or --selector <css>.");
}

function parseViewports(
  value: string | boolean | undefined,
): { width: number; height: number }[] | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((pair) => {
    const [w, h] = pair.trim().split("x");
    const width = Number(w);
    const height = Number(h);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new ConfigError(`Bad viewport "${pair}" — expected WIDTHxHEIGHT, e.g. 1280x800.`);
    }
    return { width, height };
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // A ConfigError is a message written for a human to act on — print it as-is
    // rather than burying the instructions under a stack trace.
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\n`);
    } else {
      process.stderr.write(
        `\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
    }
    process.exitCode = 1;
  });
