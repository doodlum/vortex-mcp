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
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ANONYMOUS, bootstrap, liveDir, readMarker, snapshotDir } from "./bootstrap";
import {
  ConfigError,
  REPO_ROOT,
  loadConfig,
  resolveTargetSafely,
  type HarnessConfig,
} from "./config";
import { runDoctor, formatDoctorReport } from "./doctor";
import { parseJson, stripBom } from "./jsonFile";
import { RendererEvalRefused, evalInRenderer } from "./rendererEval";
import { watchAndReload } from "./hotReload";
import { ensureExtensionBuilt, stopStaleInstance } from "./instance";
import { VortexMcpClient } from "./mcpClient";
import { formatReport, runResponsiveSweep, viewportList } from "./responsive";
import { captureScreenshot } from "./cdp";
import { startRecording } from "./recording";
import {
  formatPullRequestChecks,
  inspectPullRequestChecks,
  pullRequestChecksPassed,
} from "./prChecks";
import { PreflightError, formatPreflightReport, runPreflight } from "./prPreflight";
import { captureLogin } from "./bootstrap";
import { requireOAuth, waitForOAuth, type AuthStatus } from "./auth";
import { localOnlyConfig, sandboxConfig } from "./sandbox";
import { bethesdaSandboxConfig, isolateUserFolders } from "./bethesdaSandbox";
import { installLocalMod } from "./localMod";
import { installCollection } from "./collections";
import { deployMods, needsDeployment, purgeGame } from "./deployment";
import { runE2e } from "./e2e";
import {
  INSTANCE_RESOURCE,
  acquireLease,
  checkoutResource,
  formatLeaseStates,
  listLeases,
  releaseLease,
  resolveOwner,
  waitForLease,
  type LeaseState,
} from "./lease";
import { runUnderLease } from "./leaseCommand";
import {
  VortexE2eError,
  e2eExitCode,
  formatE2eReport,
  playwrightRunner,
  runVortexE2e,
} from "./vortexE2e";
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
  /** Every value of each string flag, for flags that may repeat (`--test a --test b`). */
  lists: Record<string, string[]>;
  /** Everything after a bare `--` (the command for `lease run`). */
  passthrough: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  // `pnpm run ai -- status` forwards the `--` separator itself, so the first
  // argument we see is "--" rather than the command. Dropping a leading bare
  // separator makes the documented invocation work instead of printing help.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command = "help", ...rest] = args;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const lists: Record<string, string[]> = {};
  const setValue = (name: string, value: string): void => {
    flags[name] = value;
    (lists[name] ??= []).push(value);
  };
  const booleanFlags = new Set([
    "help",
    "installed",
    "sandbox",
    "bethesda-sandbox",
    "isolate-user-folders",
    "headless",
    "production",
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
    "skip-revert",
    "force",
    "with-api-key",
  ]);

  const passthrough: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    // `script <file> [args...]`: everything after the file is the script's own.
    if (command === "script" && positional.length === 1) {
      passthrough.push(...(arg === "--" ? rest.slice(i + 1) : rest.slice(i)));
      break;
    }
    if (arg === "--") {
      // `pnpm run ai:<script> -- --flag` forwards its separator after the command; only
      // `lease run` gives it a meaning.
      if (command !== "lease" || positional[0] !== "run") continue;
      passthrough.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      // `lease run [flags] <command...>`: the command starts at its first word even without
      // `--`, which Windows PowerShell 5.1 strips from native command lines.
      if (command === "lease" && positional.length === 1 && positional[0] === "run") {
        passthrough.push(...rest.slice(i));
        break;
      }
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const next = rest[i + 1];
    if (eq !== -1) {
      setValue(body.slice(0, eq), body.slice(eq + 1));
    } else if (booleanFlags.has(body)) {
      flags[body] = true;
    } else if (next !== undefined && !next.startsWith("--")) {
      setValue(body, next);
      i++;
    } else {
      throw new ConfigError(`--${body} needs a value. Run help for supported flags.`);
    }
  }
  return { command, positional, flags, lists, passthrough };
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
  if (flags.production === true) overrides.production = true;
  if (typeof flags.owner === "string") overrides.owner = flags.owner;
  const config = loadConfig(overrides);
  if (flags.sandbox === true && flags["bethesda-sandbox"] === true) {
    throw new ConfigError("Choose one of --sandbox and --bethesda-sandbox.");
  }
  const keepKey = flags["with-api-key"] === true;
  if (flags["bethesda-sandbox"] === true) {
    return localOnlyConfig(bethesdaSandboxConfig(config), keepKey);
  }
  const chosen = flags.sandbox === true ? localOnlyConfig(sandboxConfig(config), keepKey) : config;
  return flags["isolate-user-folders"] === true ? isolateUserFolders(chosen) : chosen;
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
  pr-checks <pr>         Diagnose current GitHub checks and their failed steps
    --repo <owner/name>  Repository to inspect (default: Nexus-Mods/Vortex)
  pr-preflight           Mechanical checks on a Vortex branch before pushing: size,
                         callers outside the diff, revert check (negative control),
                         measurements in comments, PR description
    --checkout <dir>     Vortex checkout (default: .vortex-src)
    --base <ref>         Base to diff from (default: upstream/master, via merge-base)
    --head <ref>         Compare this ref without checking it out (no revert check)
    --test <path>        Test file for the revert check; repeatable (default: the
                         test files the diff adds or changes)
    --project-dir <dir>  Where to run vitest (default: each test's nearest package.json)
    --revert <path>      Revert only this file; repeatable (default: every non-test file)
    --skip-revert        Skip the revert check
    --pr <number|url>    Also lint that PR's title and description (--repo as above)
    --json               Machine-readable report; exit code 1 on any failure
  vortex-e2e             Run Vortex's own E2E suite (packages/e2e, CI=1, one worker, no
                         retries) under the instance lease, with the kit's fixture
                         patches applied for the run and restored byte-identically, and
                         account specs left out when their credentials are absent
    --checkout <dir>     Vortex checkout (default: .vortex-src)
    --spec <file>        Spec to run, relative to packages/e2e or src/tests; repeatable
    --grep <re> --grep-invert <re>   Playwright title filters
    --compare <json>     Diff against an earlier report: regressions vs pre-existing
    --json               Print the report as JSON (Playwright's output goes to stderr)

Leases (one harness Vortex per machine; several agents may share the kit)
  lease status           Who holds what, live or stale (--json)
  lease acquire          Hold the instance lease: --owner <name> [--purpose <text>]
                         [--ttl <minutes>, default 60; 0 = none] [--pid <n>] [--wait <min>]
                         [--checkout <dir>: lock that checkout instead]. Re-run to renew.
  lease release          --owner <name> [--force] [--checkout <dir>]
  lease run [flags] [--] <cmd...>
                         Hold the lease (and --checkout's) while <cmd> runs; exit code
                         propagated. --owner <name> [--wait <minutes>] [--purpose <text>]
                         Flags go before the command, which starts at its first word.
  Commands that start or stop Vortex take the lease implicitly and refuse while another
  owner holds it; up keeps it until down. Owner: --owner, else VORTEX_AI_OWNER, else
  "anonymous".

Driving a running instance
  tools --json           Discover every live tool and its full input schema
  call <tool> --args-file <json-file>   Invoke any tool with structured arguments
    --args <json>        Inline alternative (mind shell quoting)
  snapshot               Accessibility tree; optional --selector <css>
  click --ref <ref>       Or use --selector <css>
  fill --ref <ref> --value <text>
  press --key <Enter>     DOM key events; native typing/defaults require CDP
  screenshot             Save PNG; --label <name>, --full-page
  eval --expr "<js>"     Diagnostics only: evaluate JavaScript in a harness instance's
    eval <file.js>       renderer over CDP and print the JSON result (refuses any Vortex
                         whose profile is not in this cache). Promises are awaited.
  script <file.mts> [args...]
                         Run a scratch script with the kit's tsx under the instance lease
                         (--wait <min>); VORTEX_AI_KIT holds the import URL of harness/src/kit.ts
  record                 Save WebM; --ffmpeg <path> --seconds <1-60> --label <name>
  install <archive>      Install local ZIP/7z through Vortex; no account needed
  collection <url>       Install exact Nexus collection/revision using OAuth
  deploy                 Deploy enabled mods for the active game
    --purge              Permit purging a foreign deployment in a disposable game
  purge                  Remove files recorded in this game's deployment manifest
  e2e <collection>       Fresh start, install, verify, deploy, launch real game
    --runs <n> --keep --purge; --no-launch for installation/deployment only

Testing and iteration
  responsive             Scan width AND height changes; persist JSON evidence
    --viewports 1024x720,1280x720,1280x1080,1920x1080   (quote the list in PowerShell)
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
  --bethesda-sandbox     Fake Fallout 4 (plugins, LOOT, masters) with private
                         LocalAppData and Documents; no game install needed
  --with-api-key         Seed harness/.env's API key into a sandbox profile too (off by
                         default: with a key, every local install waits on a Nexus lookup)
  --isolate-user-folders Give any game private LocalAppData and Documents folders
  --game <id> --game-path <dir>   Real game integration; use a disposable copy
  --cache-dir <dir>      Profiles and private OAuth cache
  --port <n> --cdp-port <n>      MCP/CDP endpoints (3701/9222 by default)
  --owner <name>         Lease owner for this command (default VORTEX_AI_OWNER)
  --headless             Hide the window; screenshots/layout may differ
  --production           Run a source build as releases run (production React);
                         use for any timing meant to reflect users' experience

Without a target flag: .vortex-src if present, otherwise installed Vortex.
Read harness/AGENTS.md, the relevant skills and KNOWLEDGE.md first.
For Vortex changes also follow its AGENTS.md and linked task-specific docs.
`;
async function main(): Promise<number> {
  const { command, flags, positional, lists, passthrough } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.help === true) {
    log(HELP);
    return 0;
  }

  if (command === "pr-checks") {
    const ref = positional[0];
    if (ref === undefined) throw new ConfigError("pr-checks needs a PR number or URL.");
    const report = await inspectPullRequestChecks(
      ref,
      typeof flags.repo === "string" ? flags.repo : undefined,
    );
    log(flags.json === true ? JSON.stringify(report, null, 2) : formatPullRequestChecks(report));
    return pullRequestChecksPassed(report) ? 0 : 1;
  }

  if (command === "pr-preflight") {
    const text = (name: string): string | undefined =>
      typeof flags[name] === "string" ? flags[name] : undefined;
    let report;
    try {
      report = await runPreflight({
        checkout: text("checkout") ?? vortexSourceDir(),
        base: text("base"),
        head: text("head"),
        tests: [...(lists.test ?? []), ...positional],
        projectDir: text("project-dir"),
        revert: lists.revert,
        skipRevert: flags["skip-revert"] === true,
        pr: text("pr"),
        repo: text("repo"),
        onProgress: (message) => process.stderr.write(`${message}\n`),
        owner: text("owner"),
      });
    } catch (err) {
      if (err instanceof PreflightError) throw new ConfigError(err.message);
      throw err;
    }
    log(flags.json === true ? JSON.stringify(report, null, 2) : formatPreflightReport(report));
    return report.passed ? 0 : 1;
  }

  if (command === "lease") return leaseCommand(positional, flags, passthrough);

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
      // Windows PowerShell 5.1 writes UTF-8 with a byte-order mark, which JSON.parse rejects.
      const args: unknown = parseJson(raw);
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
        viewports: parseViewports(viewportList(flags.viewports, positional)),
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

    case "record": {
      const seconds = Number(flags.seconds ?? 15);
      if (
        !Number.isFinite(seconds) ||
        seconds < 1 ||
        seconds > 60 ||
        typeof flags.ffmpeg !== "string"
      ) {
        throw new ConfigError(
          "record requires --ffmpeg <executable> and --seconds between 1 and 60",
        );
      }
      await requireRunning(config);
      const recording = await startRecording(config, {
        encoder: flags.ffmpeg,
        label: typeof flags.label === "string" ? flags.label : "recording",
      });
      log(`Recording Vortex for ${seconds} seconds`);
      try {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      } finally {
        log(await recording.stop());
      }
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

    case "eval": {
      const file = positional[0];
      const source =
        typeof flags.expr === "string"
          ? flags.expr
          : file !== undefined
            ? stripBom(fs.readFileSync(file, "utf8"))
            : undefined;
      if (source === undefined || source.trim() === "") {
        throw new ConfigError(
          'eval needs --expr "<expression>" or a file holding one, e.g.\n' +
            '  vortex-ai eval --expr "document.title"\n' +
            "  vortex-ai eval probe.js      (an async IIFE for statements)",
        );
      }
      try {
        const result = await evalInRenderer(config, source);
        log(JSON.stringify(result.value ?? null, null, 2));
        if (!result.rendererConfirmed) {
          process.stderr.write(
            "note: the renderer could not confirm its profile; the MCP server's check passed.\n",
          );
        }
      } catch (err) {
        if (err instanceof RendererEvalRefused) throw new ConfigError(err.message);
        throw err;
      }
      return 0;
    }

    case "script": {
      const file = positional[0];
      if (file === undefined) {
        throw new ConfigError("script needs a file: vortex-ai script <file.mts> [its args...]");
      }
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new ConfigError(`${abs} does not exist.`);
      const insideRepo = !path.relative(REPO_ROOT, abs).startsWith("..");
      if (!/\.(?:mts|mjs)$/.test(abs) && !insideRepo) {
        throw new ConfigError(
          `${path.basename(abs)}: name a script outside this repo .mts. tsx treats a .ts file ` +
            "with no ESM package.json above it as CommonJS, where top-level await and imports fail.",
        );
      }
      const kit = pathToFileURL(path.join(REPO_ROOT, "harness", "src", "kit.ts")).href;
      log(`script: ${abs} (VORTEX_AI_KIT=${kit})`);
      return runUnderLease({
        command: process.execPath,
        args: [tsxCli(), abs, ...passthrough],
        owner: resolveOwner(config.owner),
        resources: [INSTANCE_RESOURCE],
        purpose: `script ${path.basename(abs)}`,
        waitMs: (typeof flags.wait === "string" ? Number(flags.wait) : 0) * 60_000,
        shell: false,
        // The script's loadConfig() then sees the same instance this command was given.
        env: {
          VORTEX_AI_KIT: kit,
          VORTEX_AI_CACHE_DIR: config.cacheDir,
          VORTEX_AI_ARTIFACT_DIR: config.artifactDir,
          VORTEX_MCP_PORT: String(config.mcpPort),
          VORTEX_AI_CDP_PORT: String(config.cdpPort),
          VORTEX_MCP_TOKEN: config.mcpToken,
        },
        onWaiting: (err) => log(`Waiting for the lease:\n${err.message}\n`),
      });
    }

    case "build-extension": {
      const root = await ensureExtensionBuilt({ rebuild: true });
      log(`Built vortex-mcp at ${root}`);
      return 0;
    }

    case "vortex-e2e": {
      const text = (name: string): string | undefined =>
        typeof flags[name] === "string" ? flags[name] : undefined;
      let report;
      try {
        report = await runVortexE2e({
          checkout: text("checkout") ?? vortexSourceDir(),
          artifactDir: config.artifactDir,
          specs: [...(lists.spec ?? []), ...positional],
          grep: text("grep"),
          grepInvert: text("grep-invert"),
          owner: config.owner,
          compare: text("compare"),
          // With --json, stdout carries only the report; Playwright's progress goes to stderr.
          runner: playwrightRunner(flags.json === true ? process.stderr : process.stdout),
          onProgress: (message) => process.stderr.write(`${message}\n`),
        });
      } catch (err) {
        if (err instanceof VortexE2eError) throw new ConfigError(err.message);
        throw err;
      }
      log(flags.json === true ? JSON.stringify(report, null, 2) : formatE2eReport(report));
      return e2eExitCode(report);
    }

    default:
      log(`Unknown command "${command}".\n`);
      log(HELP);
      return 1;
  }
}

async function leaseCommand(
  positional: string[],
  flags: ParsedArgs["flags"],
  passthrough: string[],
): Promise<number> {
  const text = (name: string): string | undefined =>
    typeof flags[name] === "string" ? flags[name] : undefined;
  const minutes = (name: string, fallback: number): number => {
    const raw = text(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(`--${name} must be a number of minutes.`);
    }
    return value;
  };
  const owner = resolveOwner(text("owner"));
  const checkout = text("checkout");
  // `lease run` holds the instance and, with --checkout, that checkout too.
  const resources =
    checkout === undefined ? [INSTANCE_RESOURCE] : [INSTANCE_RESOURCE, checkoutResource(checkout)];
  // acquire/release address one resource: the checkout when given, else the instance.
  const resource = checkout === undefined ? INSTANCE_RESOURCE : checkoutResource(checkout);
  const onReclaim = (state: LeaseState): void =>
    log(
      `Reclaimed a stale ${state.lease.resource} lease from "${state.lease.owner}" (${state.reason}).`,
    );

  switch (positional[0]) {
    case "status": {
      const states = listLeases();
      log(flags.json === true ? JSON.stringify(states, null, 2) : formatLeaseStates(states));
      return 0;
    }
    case "acquire": {
      const pid = text("pid") === undefined ? undefined : Number(text("pid"));
      if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0))
        throw new ConfigError("--pid must be a process id.");
      const ttl = minutes("ttl", 60);
      const result = await waitForLease(
        () =>
          acquireLease(resource, owner, {
            mode: "explicit",
            purpose: text("purpose"),
            ttlMinutes: ttl,
            boundPid: pid,
          }),
        minutes("wait", 0) * 60_000,
        (err) => log(`Waiting for the lease:\n${err.message}\n`),
      );
      if (result.reclaimed !== undefined) onReclaim(result.reclaimed);
      const until =
        result.lease.expiresAt === undefined ? "with no expiry" : `until ${result.lease.expiresAt}`;
      log(
        `${result.joined ? "Renewed" : "Acquired"} the ${resource} lease for "${owner}" ${until}` +
          (pid === undefined ? "" : `, while pid ${String(pid)} runs`) +
          `. Renew by acquiring again; release with \`lease release --owner ${owner}\`.`,
      );
      return 0;
    }
    case "release": {
      const result = releaseLease(resource, owner, { force: flags.force === true });
      if (!result.released) {
        log(`Not released: ${result.reason ?? "unknown"}.`);
        return result.reason === "not held" ? 0 : 1;
      }
      log(`Released the ${resource} lease.`);
      if (result.stillRunning.length > 0) {
        log(
          `A harness Vortex (pid ${result.stillRunning.join(", ")}) is still running; the next ` +
            "owner's up or down will stop it. Run `down` first to stop it yourself.",
        );
      }
      return 0;
    }
    case "run": {
      const [cmd, ...args] = passthrough;
      if (cmd === undefined) {
        throw new ConfigError(
          "lease run needs a command after --, e.g. lease run --owner qa -- pnpm run verify",
        );
      }
      return runUnderLease({
        command: cmd,
        args,
        owner,
        resources,
        purpose: text("purpose"),
        waitMs: minutes("wait", 0) * 60_000,
        onWaiting: (err) => log(`Waiting for the lease:\n${err.message}\n`),
        onReclaim,
      });
    }
    default:
      throw new ConfigError(
        "lease needs acquire, release, status or run. See help, or harness/AGENTS.md.",
      );
  }
}

function targetFrom(flags: ParsedArgs["flags"]): Record<string, unknown> {
  if (typeof flags.ref === "string") return { ref: flags.ref };
  if (typeof flags.selector === "string") return { selector: flags.selector };
  throw new ConfigError("Provide --ref <e12> (from `vortex-ai snapshot`) or --selector <css>.");
}

/** tsx's CLI in this repo's node_modules, run with this Node. */
function tsxCli(): string {
  try {
    return createRequire(import.meta.url).resolve("tsx/cli");
  } catch {
    return path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  }
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
