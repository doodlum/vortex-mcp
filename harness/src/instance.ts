/**
 * Launching and stopping a Vortex instance with this extension loaded.
 *
 * The default target is a **stock, officially released Vortex** — no patched
 * build, no source checkout. That is the whole point: everything the extension
 * does is reachable from the renderer, so an agent can drive the Vortex a user
 * actually has installed.
 *
 * Deliberately `spawn`-based rather than Playwright's `_electron.launch`: an
 * instance started by `vortex-ai up` has to outlive the process that started it,
 * so an agent can drive it across many separate tool calls. A Playwright-owned
 * Electron dies with its controlling script. The Playwright specs get their own
 * fixture (src/tests/fixtures.ts), because a test genuinely does want that.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { extensionRoot, MCP_EXTENSION_ID, type HarnessConfig } from "./config";
import { VortexMcpClient } from "./mcpClient";
import { installSandboxExtension } from "./sandbox";
import { preparePreload, verifyPreload } from "./mainPreload";
import {
  INSTANCE_RESOURCE,
  addInstancePid,
  checkoutResource,
  holdLease,
  removeInstancePid,
  resolveOwner,
  type HoldResult,
  type LeaseEnv,
} from "./lease";
import {
  ProductionModeError,
  bundleModeOf,
  devBundleWarning,
  productionErrorMessage,
  productionProblem,
  type ProductionStatus,
} from "./productionMode";

const execFileAsync = promisify(execFile);

/**
 * Hold the machine-wide instance lease for the rest of this process (see lease.ts).
 *
 * Every path that starts or stops Vortex calls this first, so one agent cannot quit or
 * replace another's instance. Free or stale: taken. Same owner: joined. Another live
 * owner: LeaseHeldError, naming the holder and how to wait or release.
 */
export function claimInstanceLease(
  config: HarnessConfig,
  purpose: string,
  leaseEnv: LeaseEnv = {},
  options: { attach?: boolean } = {},
): HoldResult {
  const owner = resolveOwner(config.owner);
  const held: HoldResult[] = [];
  const resources =
    options.attach === true ? attachedLeaseResources(config) : instanceLeaseResources(config);
  try {
    // The instance first: a caller refused it has touched nothing else.
    for (const resource of resources) {
      held.push(
        holdLease(resource, owner, {
          ...leaseEnv,
          purpose,
          onReclaim: (state) =>
            process.stderr.write(
              `[lease] reclaimed a stale ${resource} lease from "${state.lease.owner}" (${state.reason})\n`,
            ),
        }),
      );
    }
  } catch (err) {
    for (const hold of held.toReversed()) hold.release();
    throw err;
  }
  const first = held[0]!;
  return { ...first, release: () => held.toReversed().forEach((hold) => hold.release()) };
}

/**
 * The leases a running Vortex needs: the instance, and for a source build the checkout it
 * runs from, so nobody rebuilds or switches that checkout underneath it (and a holder of
 * the checkout lock who starts Vortex also takes the instance).
 */
export function instanceLeaseResources(config: HarnessConfig): string[] {
  const checkout = config.target.kind === "dev" ? config.target.sourceDir : undefined;
  return checkout === undefined
    ? [INSTANCE_RESOURCE]
    : [INSTANCE_RESOURCE, checkoutResource(checkout)];
}

/**
 * The leases a command driving an already-running Vortex needs: the instance, and the
 * checkout that Vortex was launched from (recorded in the cache at launch), not whatever
 * checkout this command's own configuration would pick.
 */
export function attachedLeaseResources(config: HarnessConfig): string[] {
  const running = runningInstance(config);
  return running?.sourceDir === undefined
    ? [INSTANCE_RESOURCE]
    : [INSTANCE_RESOURCE, checkoutResource(running.sourceDir)];
}

interface InstanceRecord {
  pid: number;
  /** The Vortex checkout it runs from, for a source build. */
  sourceDir?: string;
}

function instanceRecordFile(config: HarnessConfig): string {
  return path.join(config.cacheDir, "instance.json");
}

function runningInstanceRecord(config: HarnessConfig): InstanceRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(instanceRecordFile(config), "utf8")) as InstanceRecord;
  } catch {
    return undefined;
  }
}

/** The harness Vortex this cache last launched, while it still runs. */
export function runningInstance(config: HarnessConfig): InstanceRecord | undefined {
  const record = runningInstanceRecord(config);
  return record !== undefined && Number.isInteger(record.pid) && isAlive(record.pid)
    ? record
    : undefined;
}

/** Record a launched Vortex on every lease it needs, so they outlive the launching command. */
export function recordLaunchedPid(
  config: HarnessConfig,
  pid: number,
  leaseEnv: LeaseEnv = {},
): void {
  for (const resource of instanceLeaseResources(config)) addInstancePid(resource, pid, leaseEnv);
}

/** Forget a Vortex that has exited, on every lease it was recorded on. */
export function forgetLaunchedPid(
  config: HarnessConfig,
  pid: number,
  leaseEnv: LeaseEnv = {},
): void {
  for (const resource of instanceLeaseResources(config)) removeInstancePid(resource, pid, leaseEnv);
}

export function authCacheFile(config: HarnessConfig): string {
  const key = createHash("sha256")
    .update(`${config.target.kind}:${config.target.appName}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(config.cacheDir, `oauth-${key}.json`);
}

export interface VortexInstance {
  process: ChildProcess;
  userDataDir: string;
  mcp: VortexMcpClient;
  stop: (options?: { force?: boolean }) => Promise<void>;
}

/**
 * Build the environment for an isolated Vortex instance.
 *
 * `VORTEX_E2E=1` is doing two jobs here and both are required:
 *   1. It is the gate on `ELECTRON_USERDATA`/`ELECTRON_APPDATA` being honoured
 *      at all — without it the instance writes to the user's real Vortex data.
 *   2. It skips the single-instance lock, so a harness instance can run
 *      alongside the operator's own Vortex.
 *
 * Both are honoured by the *released* build, not just a source checkout, which
 * is what makes isolated automation against a stock install possible.
 *
 * Its third effect is a real trade-off: it also disables startup game
 * discovery. The harness works around that by setting the game path explicitly
 * (see gameSetup.ts), which is faster than a scan and deterministic anyway.
 */
/** Where the harness reads a Nexus API key from; stripped from Vortex's env unless in use. */
export const API_KEY_VARIABLES = ["VORTEX_AI_NEXUS_API_KEY", "NEXUS_API_KEY"] as const;

export function buildInstanceEnv(
  userDataDir: string,
  config: HarnessConfig,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // ELECTRON_RUN_AS_NODE would make the child start as a plain Node process
    // rather than an Electron app — inherited from a tsx parent otherwise.
    if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) env[key] = value;
  }

  env.ELECTRON_USERDATA = path.join(userDataDir, "userData");
  env.ELECTRON_APPDATA = path.join(userDataDir, "appData");
  env.VORTEX_E2E = "1";
  env.VORTEX_MCP_TOKEN = config.mcpToken;
  env.VORTEX_MCP_PORT = String(config.mcpPort);
  env.VORTEX_AI_AUTH_CACHE = authCacheFile(config);
  if (config.headless) env.VORTEX_E2E_HEADLESS = "1";
  // Vortex reads LOCALAPPDATA straight from the environment for plugins.txt and
  // loadorder.txt, in both processes. Documents cannot be moved this way; see
  // mainPreload.ts.
  if (config.profileRedirect !== undefined) {
    env.LOCALAPPDATA = config.profileRedirect.localAppData;
  }
  // A source checkout only loads its extensions and devtools wiring under
  // development; a released build ignores this.
  if (config.target.kind === "dev") {
    // Set, never deleted: a plain `pnpm run build` inlines NODE_ENV="development" into
    // main.cjs, so main never switches itself to production, and a renderer launched
    // without NODE_ENV loads React's development build (see productionMode.ts).
    env.NODE_ENV = config.production ? "production" : "development";
  }
  // Sandbox runs are local-only and withhold the API key; harness/.env has put it in this
  // process's environment, and nothing a launched Vortex runs needs to inherit it.
  if (config.apiKey === undefined || config.apiKey.trim() === "") {
    for (const key of API_KEY_VARIABLES) delete env[key];
  }

  return env;
}

/**
 * Create the directory layout Vortex expects before first launch.
 *
 * The app-name subdirectory under appData is where Vortex writes startup.json,
 * and it must exist beforehand. The name differs between a released build
 * (`Vortex`) and a source checkout (`@vortex/main`) — getting it wrong makes
 * Vortex quit during startup with an unrecoverable ENOENT that looks nothing
 * like a naming problem.
 */
export function prepareUserDataDir(userDataDir: string, appName: string): void {
  fs.mkdirSync(path.join(userDataDir, "appData", ...appName.split("/")), { recursive: true });
  fs.mkdirSync(path.join(userDataDir, "userData", "plugins"), { recursive: true });
}

/**
 * Copy the built extension into an instance's plugins directory.
 *
 * Vortex loads user extensions from `<userData>/plugins/<id>`, and `<id>` must
 * match info.json's `id` or Vortex treats it as a different extension next run.
 */
export function installMcpExtension(userDataDir: string, source = extensionRoot()): void {
  const target = path.join(userDataDir, "userData", "plugins", MCP_EXTENSION_ID);
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(source, "dist"), target, { recursive: true });
  fs.cpSync(path.join(source, "info.json"), path.join(target, "info.json"));

  // Pin the extension to CommonJS.
  //
  // Node decides a .js file's module type from the NEAREST package.json up the
  // tree. An instance directory living under a `"type": "module"` package (this
  // harness is one) makes Node parse the extension's CommonJS bundle as ESM.
  // That fails in the worst possible way: require() returns an empty namespace,
  // the module body never runs, nothing throws, and Vortex reports only
  // "corrupt extension, failed to initialize" with no hint that module
  // resolution was the problem.
  fs.writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify({ name: MCP_EXTENSION_ID, type: "commonjs", main: "index.js" }, null, 2)}\n`,
  );
}

export class ExtensionMissingError extends Error {}

async function assertPortAvailable(port: number): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied. Choose unused --port and --cdp-port values; no new Vortex was launched.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

/** Ensure the extension is built, building it when needed. Returns this repo's root. */
export async function ensureExtensionBuilt(options: { rebuild?: boolean } = {}): Promise<string> {
  const source = extensionRoot();
  const dist = path.join(source, "dist", "index.js");

  const buildTime = fs.existsSync(dist) ? fs.statSync(dist).mtimeMs : 0;
  const inputs = fs
    .readdirSync(path.join(source, "src"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => path.join(source, "src", file));
  inputs.push(path.join(source, "tsup.config.ts"), path.join(source, "package.json"));
  if (options.rebuild === true || inputs.some((file) => fs.statSync(file).mtimeMs > buildTime)) {
    const pnpmScript = process.env.npm_execpath;
    await execFileAsync(
      pnpmScript ? process.execPath : "pnpm",
      pnpmScript ? [pnpmScript, "run", "build"] : ["run", "build"],
      {
        cwd: source,
        shell: pnpmScript === undefined,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  }
  if (!fs.existsSync(dist)) {
    throw new ExtensionMissingError(`The extension build produced no ${dist}.`);
  }
  return source;
}

/**
 * Remove an instance directory, retrying past transient Windows locks.
 *
 * Vortex's state database keeps file handles open for a moment after the
 * process exits, so an immediate rmSync loses a race and throws EPERM. Retrying
 * turns that into a short wait rather than a failed run.
 */
export function removeInstanceDir(dir: string, attempts = 5): void {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === attempts) {
        throw new Error(
          `Could not remove ${dir} after ${String(attempts)} attempts: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `A Vortex process is probably still holding it — close it and retry.`,
          { cause: err },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 400);
    }
  }
}

/** Where the PID of the most recently launched instance is recorded. */
function pidFile(config: HarnessConfig): string {
  return path.join(config.cacheDir, "instance.pid");
}

function recordPid(config: HarnessConfig, pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(pidFile(config), String(pid));
    const record: InstanceRecord = {
      pid,
      ...(config.target.kind === "dev" && config.target.sourceDir !== undefined
        ? { sourceDir: config.target.sourceDir }
        : {}),
    };
    fs.writeFileSync(instanceRecordFile(config), `${JSON.stringify(record)}\n`);
  } catch {
    // Best-effort bookkeeping; never fail a launch over it.
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering one.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shut down an instance left behind by an earlier run.
 *
 * Two mechanisms, because they cover different failures. MCP is the graceful
 * path and flushes state. But the case that actually strands a directory is an
 * instance whose extension never loaded — it holds the user-data directory and
 * answers nothing, so there is no polite channel to it at all. That is why the
 * PID is recorded at launch: it is the only handle on a Vortex that is running
 * but unreachable, and without it the next run fails on an EPERM that says
 * nothing about the real cause.
 */
export async function stopStaleInstance(config: HarnessConfig): Promise<boolean> {
  // Refuses before touching anything when another owner holds the instance.
  claimInstanceLease(config, "stop a harness instance");
  let stopped = false;
  const file = pidFile(config);
  const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) : undefined;
  const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
  if (await mcp.ping()) {
    const status = await mcp.call<{ userDataDir: string | null }>("automation_status");
    const relative =
      status.userDataDir === null
        ? ".."
        : path.relative(path.resolve(config.cacheDir), path.resolve(status.userDataDir));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(
        `Port ${config.mcpPort} belongs to a different Vortex profile. Choose another --port and --cdp-port.`,
      );
    }
    await mcp.call("vortex_quit");
    stopped = true;
  }
  const deadline = Date.now() + 30_000;
  const recordedProcessAlive = (): boolean =>
    pid !== undefined && Number.isInteger(pid) && pid > 0 && isAlive(pid);
  while (recordedProcessAlive() || (await mcp.ping())) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Vortex did not exit cleanly. The profile has been preserved; close the harness window before retrying. No snapshot was copied and no PID was killed.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const record = runningInstanceRecord(config);
  fs.rmSync(file, { force: true });
  fs.rmSync(instanceRecordFile(config), { force: true });
  if (pid !== undefined && Number.isInteger(pid)) {
    forgetLaunchedPid(config, pid);
    // It may have run from another checkout than this command's configuration names.
    if (record?.sourceDir !== undefined) {
      removeInstancePid(checkoutResource(record.sourceDir), pid);
    }
  }
  return stopped;
}

export interface LaunchOptions {
  userDataDir: string;
  config: HarnessConfig;
  /** Progress and warnings, such as a development bundle under --production. */
  onProgress?: (message: string) => void;
}

/** Where a detached Vortex's own stdout and stderr go: `<instance dir>/vortex-stdio.log`. */
export function stdioLogFile(userDataDir: string): string {
  return path.join(userDataDir, "vortex-stdio.log");
}

function openStdioLog(userDataDir: string): number | undefined {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    return fs.openSync(stdioLogFile(userDataDir), "w");
  } catch {
    return undefined;
  }
}

/**
 * How Vortex is spawned. Detached, so it outlives the `vortex-ai` process that started it, and
 * with none of that process's stdio: stdin is ignored and stdout/stderr go to a log file (or
 * nowhere). A Vortex holding the caller's pipes keeps a shell that captures `up`'s output
 * (PowerShell `*>`, `| Select-String`, a tool reading stdout) waiting until Vortex exits.
 * Nothing else Vortex writes is lost that way: its own log is `userData/vortex.log`.
 */
export function launchStdio(logFd: number | undefined): {
  stdio: ["ignore", number | "ignore", number | "ignore"];
  detached: true;
  windowsHide: false;
} {
  const out = logFd ?? "ignore";
  return { stdio: ["ignore", out, out], detached: true, windowsHide: false };
}

/**
 * Start Vortex and wait until its MCP server answers.
 *
 * CDP is always enabled. Electron parses `--remote-debugging-port` from argv
 * itself, so this works on the released build too — and it is what screenshots
 * and the Playwright specs attach to, replacing what would otherwise have to be
 * a patch to Vortex core.
 *
 * "Answers MCP" rather than "process started" is the readiness signal on
 * purpose: the extension registers in `context.once`, which runs only after the
 * renderer has loaded its extensions and the store is live. A port check or a
 * fixed sleep would both report ready while the app is still on the splash
 * screen, and every subsequent tool call would fail confusingly.
 */
export async function launchVortex(options: LaunchOptions): Promise<VortexInstance> {
  const { userDataDir, config } = options;
  const { target } = config;
  claimInstanceLease(config, "launch Vortex");
  installSandboxExtension(userDataDir, config);
  await assertPortAvailable(config.mcpPort);
  await assertPortAvailable(config.cdpPort);

  if (target.executable === "") {
    throw new Error(
      "No Vortex executable resolved. Run `vortex-ai doctor` — it will say what is missing.",
    );
  }

  const redirect = config.profileRedirect;
  const env = buildInstanceEnv(userDataDir, config);
  const preload =
    redirect !== undefined
      ? preparePreload(userDataDir, { documents: redirect.documents })
      : undefined;
  if (preload !== undefined) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, preload.nodeOptions].filter(Boolean).join(" ");
  }

  const logFd = openStdioLog(userDataDir);
  let child: ChildProcess;
  try {
    child = spawn(
      target.executable,
      [...target.args, `--remote-debugging-port=${String(config.cdpPort)}`],
      { env, cwd: path.dirname(target.executable), ...launchStdio(logFd) },
    );
  } finally {
    // The child has its own copy; this process must not keep the log open.
    if (logFd !== undefined) fs.closeSync(logFd);
  }
  child.unref();
  recordPid(config, child.pid);
  // A detached instance keeps the lease after this process exits, until `down`.
  if (child.pid !== undefined) recordLaunchedPid(config, child.pid);

  if (redirect !== undefined && preload !== undefined) {
    try {
      // The record is written on the main process's first line; game activation, the
      // first thing that writes under Documents, is seconds later in the renderer.
      await verifyPreload(preload.recordFile, { documents: redirect.documents }, 5_000);
    } catch (err) {
      // Stopped before a game could activate: nothing reached the real folders.
      child.kill();
      throw err;
    }
  }

  const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });

  // Fail fast on an early crash rather than waiting out the readiness timeout.
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => (exited = { code, signal }));
  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });

  const readyController = new AbortController();
  const readiness = mcp.waitUntilReady(180_000, 500, readyController.signal);
  let timer: ReturnType<typeof setInterval>;
  const crashWatch = new Promise<never>((_resolve, reject) => {
    timer = setInterval(() => {
      if (spawnError !== undefined) {
        clearInterval(timer);
        reject(spawnError);
      } else if (exited !== undefined) {
        clearInterval(timer);
        reject(
          new Error(
            `Vortex exited (code=${String(exited.code)} signal=${String(exited.signal)}) before ` +
              `its MCP server came up. Check ` +
              `${path.join(userDataDir, "userData", "vortex.log")}.`,
          ),
        );
      }
    }, 250);
    timer.unref();
  });

  try {
    await Promise.race([readiness, crashWatch]);
  } finally {
    clearInterval(timer!);
    readyController.abort();
  }

  const instance: VortexInstance = {
    process: child,
    userDataDir,
    mcp,
    stop: (stopOptions = {}) => stopInstance(child, mcp, { ...stopOptions, config }),
  };
  await checkProductionMode(instance, config, options.onProgress);
  return instance;
}

/**
 * Under `--production`, refuse an instance whose renderer is not running production React,
 * stopping it cleanly first. Also warn when the checkout is a development bundle.
 */
async function checkProductionMode(
  instance: VortexInstance,
  config: HarnessConfig,
  report: ((message: string) => void) | undefined,
): Promise<void> {
  if (config.target.kind !== "dev" || !config.production) return;
  const sourceDir = config.target.sourceDir;
  if (sourceDir !== undefined && bundleModeOf(sourceDir) === "development") {
    (report ?? ((message: string) => process.stderr.write(`${message}\n`)))(
      `warning: ${devBundleWarning(sourceDir)}`,
    );
  }
  const status = await instance.mcp.call<ProductionStatus>("automation_status");
  const problem = productionProblem(status);
  if (problem === undefined) return;
  await instance.stop().catch(() => instance.stop({ force: true }).catch(() => undefined));
  throw new ProductionModeError(productionErrorMessage(problem));
}

/**
 * Stop an instance, preferring Vortex's own graceful shutdown.
 *
 * This matters more than it looks: Vortex flushes its state store on a clean
 * quit. A hard kill can leave the cached profile half-written, which then makes
 * the *next* warm start fail in a way that looks unrelated.
 */
export async function stopInstance(
  child: ChildProcess,
  mcp: VortexMcpClient,
  options: { force?: boolean; timeoutMs?: number; config?: HarnessConfig } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;

  if (options.force !== true) {
    // vortex_quit closes the window, which is Vortex's own clean-shutdown path.
    // Best-effort: if the app is already gone the call just fails, and the exit
    // wait below settles immediately anyway.
    await mcp.call("vortex_quit").catch(() => undefined);
  }

  const exited = await waitForExit(child, timeoutMs);
  if (!exited) {
    if (options.force !== true)
      throw new Error(
        "Vortex did not exit cleanly; refusing to snapshot potentially unflushed state.",
      );
    child.kill("SIGKILL");
    if (!(await waitForExit(child, 5_000)))
      throw new Error("Vortex did not exit after forced shutdown.");
  }
  if (child.pid !== undefined) {
    if (options.config === undefined) removeInstancePid(INSTANCE_RESOURCE, child.pid);
    else forgetLaunchedPid(options.config, child.pid);
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
