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

import { ANONYMOUS, bootstrap, liveDir, readMarker, snapshotDir } from "./bootstrap";
import { ConfigError, loadConfig, resolveTargetSafely, type HarnessConfig } from "./config";
import { runDoctor, formatDoctorReport } from "./doctor";
import { watchAndReload } from "./hotReload";
import { ensureExtensionBuilt, stopStaleInstance } from "./instance";
import { VortexMcpClient } from "./mcpClient";
import { formatReport, runResponsiveSweep } from "./responsive";
import { captureScreenshot } from "./cdp";
import { captureLogin } from "./bootstrap";
import { requireOAuth, waitForOAuth, type AuthStatus } from "./auth";
import { sandboxConfig } from "./sandbox";
import { installLocalMod } from "./localMod";
import { installCollection } from "./collections";
import { deployMods, needsDeployment, purgeGame } from "./deployment";
import { runE2e } from "./e2e";
import {
  buildVortexSource,
  detectGitHubUser,
  ensureVortexSource,
  hasVortexSource,
  resolveVortexRepo,
  vortexSourceDir,
} from "./source";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  // `pnpm run ai -- status` forwards the `--` separator itself, so the first
  // argument we see is "--" rather than the command. Dropping a leading bare
  // separator makes the documented invocation work instead of printing help.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command = "help", ...rest] = args;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const booleanFlags = new Set([
    "help",
    "installed",
    "sandbox",
    "headless",
    "oauth",
    "no-wait",
    "no-launch",
    "fresh",
    "no-game",
    "rebuild-snapshot",
    "rebuild-extension",
    "json",
    "screenshots",
    "strict",
    "build",
    "update",
    "no-build",
    "where",
    "purge",
    "keep",
    "full-page",
    "allow-incomplete",
  ]);

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
    } else if (booleanFlags.has(body)) {
      flags[body] = true;
    } else if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      throw new ConfigError(`--${body} needs a value. Run help for supported flags.`);
    }
  }
  return { command, positional, flags };
}

function configFrom(flags: ParsedArgs["flags"]): HarnessConfig {
  const overrides: Partial<HarnessConfig> = {};
  if (typeof flags.game === "string") overrides.gameId = flags.game;
  if (typeof flags["game-path"] === "string") overrides.gamePath = flags["game-path"];
  if (
    typeof flags["dev-dir"] === "string" ||
    typeof flags.exe === "string" ||
    flags.installed === true
  ) {
    overrides.target = resolveTargetSafely({
      devDir: typeof flags["dev-dir"] === "string" ? flags["dev-dir"] : undefined,
      exe: typeof flags.exe === "string" ? flags.exe : undefined,
      preferInstalled: flags.installed === true,
    });
  }
  if (typeof flags.port === "string") overrides.mcpPort = Number(flags.port);
  if (typeof flags["cdp-port"] === "string") overrides.cdpPort = Number(flags["cdp-port"]);
  if (typeof flags["cache-dir"] === "string") overrides.cacheDir = path.resolve(flags["cache-dir"]);
  if (flags.headless === true) overrides.headless = true;
  const config = loadConfig(overrides);
  return flags.sandbox === true ? sandboxConfig(config) : config;
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

const HELP = `vortex-ai — automation for stock Vortex and Vortex development

First run (no account or installed game required)
  pnpm install
  pnpm run build
  pnpm run ai -- doctor --installed --sandbox
  pnpm run ai -- setup --installed --sandbox
  pnpm run ai:test

Initial account setup (only for Nexus collections)
  setup --oauth          Open isolated Vortex, wait for browser login, cache OAuth
                         automatically, verify credentials survive a fresh start
    --no-wait            Return with login pending; finish with save-login
  auth-status            Print presence booleans only; never print credentials
  save-login             Verify OAuth, stop cleanly, capture the current baseline

Instance lifecycle
  doctor                 Report prerequisites and actionable fixes
  up                     Start/restart the matching working profile
    --fresh              Reset working state from its baseline; reuse current OAuth
    --no-game            Global UI without managing a game
    --rebuild-snapshot   Rebuild baseline with current OAuth cache
    --rebuild-extension  Force extension build
  bootstrap              Build/reset baseline and launch (--no-game supported)
  down                   Quit this cache's Vortex and wait for clean exit
  status                 Show endpoint and profile cache status
  source                 Find your fork, clone to .vortex-src and build Vortex
    --update             Fetch origin and upstream in an existing clone
    --no-build           Clone only
    --where              Print managed source path

Driving a running instance
  tools --json           Discover every live tool and its full input schema
  call <tool> --args-file <json-file>   Invoke any tool with structured arguments
    --args <json>        Inline alternative (mind shell quoting)
  snapshot               Accessibility tree; optional --selector <css>
  click --ref <ref>       Or use --selector <css>
  fill --ref <ref> --value <text>
  press --key <Enter>     DOM key events; native typing/defaults require CDP
  screenshot             Save PNG; --label <name>, --full-page
  install <archive>      Install local ZIP/7z through Vortex; no account needed
  collection <url>       Install exact Nexus collection/revision using OAuth
  deploy                 Deploy enabled mods for the active game
    --purge              Permit purging a foreign deployment in a disposable game
  purge                  Remove files recorded in this game's deployment manifest
  e2e <collection>       Fresh start, install, verify, deploy, launch real game
    --runs <n> --keep --purge; --no-launch for installation/deployment only

Testing and iteration
  responsive             Scan width AND height changes; persist JSON evidence
    --viewports 1024x720,1280x720,1280x1080,1920x1080
    --screenshots        Save PNG per viewport
    --strict             Nonzero exit for viewport-dependent findings or overflow
  watch                  Reload after extension/renderer rebuilds
    --build              Build extension when source changes
  build-extension        Force extension build

Target and isolation (repeat the same flags for all commands)
  --installed            Use released Vortex even when .vortex-src exists
  --exe <path>           Explicit Vortex.exe
  --dev-dir <path>       Explicit source checkout
  --sandbox              Disposable test game for local install/deploy tests
  --game <id> --game-path <dir>   Real game integration; use a disposable copy
  --cache-dir <dir>      Profiles and private OAuth cache
  --port <n> --cdp-port <n>      MCP/CDP endpoints (3701/9222 by default)
  --headless             Hide the window; screenshots/layout may differ

Without a target flag: .vortex-src if present, otherwise installed Vortex.
Read harness/AGENTS.md, the relevant skills and KNOWLEDGE.md first.
For Vortex changes also follow its AGENTS.md and linked task-specific docs.
`;
async function main(): Promise<number> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.help === true) {
    log(HELP);
    return 0;
  }

  const config = configFrom(flags);

  switch (command) {
    case "install": {
      const file = positional[0];
      if (!file) throw new ConfigError("install needs the path to a local mod archive.");
      log(JSON.stringify(await installLocalMod(await requireRunning(config), file), null, 2));
      return 0;
    }
    case "setup": {
      const result = await bootstrap(config, {
        skipGame: flags.oauth === true || flags["no-game"] === true,
        onProgress: log,
      });
      if (flags.oauth !== true) {
        log(`Ready: ${result.instance.mcp.url}. Use snapshot or call to drive it.`);
        return 0;
      }
      const auth = await result.instance.mcp.call<AuthStatus>("nexus_auth_status");
      if (auth.oauthPresent && auth.oauthRefreshable) {
        await captureLogin(config, { onProgress: log });
        const restored = await bootstrap(config, { skipGame: true, fresh: true, onProgress: log });
        await requireOAuth(restored.instance.mcp);
        log("Existing OAuth login cached and present after a fresh restore. Setup complete.");
        return 0;
      }
      // Only this harness-owned profile is changed; a seeded API key hides the
      // login button, preventing the initial OAuth flow.
      if (auth.apiKeyPresent) {
        await result.instance.mcp.call("vortex_dispatch", {
          action: "type:SET_USER_API_KEY",
          args: [null],
        });
      }
      log("Initial setup: click Log in in the isolated Vortex and complete the browser flow.");
      if (flags["no-wait"] === true) {
        log("Then run `pnpm run ai -- save-login` with these same configuration flags.");
        return 0;
      }
      log("Waiting up to 10 minutes; OAuth login will be cached automatically.");
      await waitForOAuth(result.instance.mcp);
      await captureLogin(config, { onProgress: log });
      const restored = await bootstrap(config, { skipGame: true, fresh: true, onProgress: log });
      await requireOAuth(restored.instance.mcp);
      log("OAuth credentials cached and verified after a fresh restore. Setup complete.");
      return 0;
    }
    case "auth-status": {
      const mcp = await requireRunning(config);
      log(JSON.stringify(await mcp.call<AuthStatus>("nexus_auth_status"), null, 2));
      return 0;
    }
    case "call": {
      const name = positional[0];
      if (!name)
        throw new ConfigError("call needs a tool name; run tools --json to inspect schemas.");
      const raw =
        typeof flags["args-file"] === "string"
          ? fs.readFileSync(flags["args-file"], "utf8")
          : typeof flags.args === "string"
            ? flags.args
            : "{}";
      const args: unknown = JSON.parse(raw);
      if (args === null || typeof args !== "object" || Array.isArray(args))
        throw new ConfigError("Tool arguments must be a JSON object.");
      const mcp = await requireRunning(config);
      log(JSON.stringify(await mcp.call(name, args as Record<string, unknown>), null, 2));
      return 0;
    }
    case "doctor": {
      const report = await runDoctor(config, { skipGame: flags["no-game"] === true });
      log(formatDoctorReport(report));
      return report.ok ? 0 : 1;
    }

    case "bootstrap": {
      const result = await bootstrap(config, {
        skipGame: flags["no-game"] === true,
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
        rebuildSnapshot: flags["rebuild-snapshot"] === true,
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
      log((await stopStaleInstance(config)) ? "Vortex exited cleanly." : "Nothing is running.");
      return 0;
    }

    case "status": {
      const apiKey = config.apiKey;
      const snapshot = snapshotDir(config, apiKey?.trim() || ANONYMOUS, flags["no-game"] === true);
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
      if (flags.json === true) {
        log(JSON.stringify(tools, null, 2));
        return 0;
      }
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
      return (report.regressions.length > 0 || report.overflowViewports.length > 0) &&
        flags.strict === true
        ? 1
        : 0;
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

    case "source": {
      // Everything needed to go from "just cloned this repo" to "can build and
      // test Vortex", in one command.
      if (flags.where === true) {
        log(vortexSourceDir());
        return 0;
      }

      if (!hasVortexSource() || flags.update === true) {
        if (!hasVortexSource()) {
          const user = await detectGitHubUser();
          log(`GitHub user: ${user ?? "(unknown)"}`);
          const repo = await resolveVortexRepo();
          log(`Fork:        ${repo.fullName}`);
        }
        const source = await ensureVortexSource({
          update: flags.update === true,
          onProgress: (m) => log(`  ${m}`),
        });
        log(source.cloned ? `Cloned to ${source.dir}` : `Using existing clone at ${source.dir}`);
      } else {
        log(`Clone already present at ${vortexSourceDir()}`);
      }

      if (flags.build !== false && flags["no-build"] !== true) {
        await buildVortexSource({ onProgress: (m) => log(`  ${m}`) });
      }

      log("");
      log("Ready. `pnpm run ai:up` will now drive this clone.");
      return 0;
    }

    case "collection": {
      const mcp = await requireRunning(config);
      const target = typeof flags.url === "string" ? flags.url : positional[0];
      if (target === undefined) {
        throw new ConfigError(`collection needs a collection to install, e.g.
  vortex-ai collection https://next.nexusmods.com/fallout4/collections/<slug>`);
      }
      const result = await installCollection(mcp, target, {
        onProgress: (m) => log(`  ${m}`),
      });
      log("");
      log(`Installed collection ${result.ref.slug} (${result.ref.gameId})`);
      log(`  mod id: ${result.modId ?? "unknown"}`);
      log(
        `  required mods installed: ${String(result.modCount)}/${String(result.expectedModCount)}`,
      );
      if (!result.complete) {
        log("");
        log("  Not every required mod installed. `View failed mods` on the");
        log("  collection page says which, and its archive is usually already");
        log("  downloaded, so a retry from there does not re-fetch it.");
      }
      return result.complete ? 0 : 1;
    }

    case "deploy": {
      const mcp = await requireRunning(config);
      await deployMods(mcp, config.gameId, {
        allowForeignPurge: flags.purge === true,
        allowIncomplete: flags["allow-incomplete"] === true,
        onProgress: (m) => log(`  ${m}`),
      });
      const pending = await needsDeployment(mcp, config.gameId);
      log("");
      log(
        pending
          ? `${config.gameId} still reports undeployed changes.`
          : `Deployed ${config.gameId}.`,
      );
      return pending ? 1 : 0;
    }

    case "purge": {
      const mcp = await requireRunning(config);
      await purgeGame(mcp, { allowForeignPurge: true, onProgress: (m) => log(`  ${m}`) });
      log("");
      log(`Purged ${config.gameId}; the game directory is back to unmodded.`);
      return 0;
    }

    case "save-login": {
      const snapshot = await captureLogin(config, { onProgress: (m) => log(`  ${m}`) });
      log("");
      log("Login captured. `up --fresh` will now start already signed in.");
      log(`  ${snapshot}`);
      log("");
      log("Vortex was stopped to flush its state; bring it back with `vortex-ai up`.");
      return 0;
    }

    case "e2e": {
      const target = typeof flags.url === "string" ? flags.url : positional[0];
      if (target === undefined) {
        throw new ConfigError("e2e needs a collection, e.g.\n  vortex-ai e2e <collection url>");
      }
      const runs = typeof flags.runs === "string" ? Number.parseInt(flags.runs, 10) : 1;
      if (!Number.isInteger(runs) || runs < 1)
        throw new ConfigError("--runs must be a positive integer");

      const outcomes: boolean[] = [];
      for (let run = 1; run <= runs; run++) {
        log("");
        log(`=== run ${String(run)} of ${String(runs)} ===`);
        try {
          const result = await runE2e(config, {
            collection: target,
            fresh: flags.keep !== true,
            purge: flags.purge === true,
            skipLaunch: flags["no-launch"] === true,
            onProgress: (m) => log(m),
          });
          outcomes.push(result.ok);
          log(`run ${String(run)} PASSED in ${String(Math.round(result.elapsedMs / 1000))}s`);
        } catch (err) {
          outcomes.push(false);
          log(`run ${String(run)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const passed = outcomes.filter(Boolean).length;
      log("");
      log(`${String(passed)}/${String(runs)} runs passed`);
      return passed === runs ? 0 : 1;
    }

    case "build-extension": {
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
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
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
