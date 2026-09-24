/**
 * Machine-wide leases: who may start, stop or drive Vortex, and who may patch a checkout.
 *
 * Only one harness Vortex can usefully run on a machine at a time, and several agents
 * (an orchestrator, QA agents) may use this kit at once. Before leases, `up` quietly quit
 * whatever harness instance was running, so a second agent ended the first one's session.
 *
 * A lease is a JSON file in a directory shared by every kit checkout on the machine
 * (`~/.vortex-ai/leases`, or `VORTEX_AI_LEASE_DIR`). Its resource key says what it guards:
 * `instance` for Vortex itself, `checkout:<path>` for a Vortex checkout a command rewrites.
 *
 * Two kinds:
 *   - **implicit**: taken by a command for as long as it runs. It is live while any holder
 *     process, or any Vortex that command launched, is alive. `up` ends with only the
 *     Vortex left holding it, so the lease lasts until `down`.
 *   - **explicit**: taken with `vortex-ai lease acquire`. It is live until its TTL passes
 *     (re-acquiring renews it) or, with `--pid`, while that process lives.
 *
 * A lease whose holder is gone is stale and is reclaimed by the next acquirer, which says
 * so. Acquisition runs under an exclusive-create mutex so two agents cannot both win.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { ConfigError } from "./config";
import { parseJson } from "./jsonFile";

export const ANONYMOUS_OWNER = "anonymous";
export const INSTANCE_RESOURCE = "instance";

export type LeaseMode = "implicit" | "explicit";

export interface Lease {
  resource: string;
  owner: string;
  mode: LeaseMode;
  purpose?: string;
  acquiredAt: string;
  /** Last acquire or renewal by the owner. */
  heartbeatAt: string;
  /** Explicit leases only: when the lease lapses unless renewed. */
  expiresAt?: string;
  /** Explicit leases only: the process whose life the lease is bound to (`--pid`). */
  boundPid?: number;
  /** Processes currently holding the lease: the acquirer and same-owner joiners. */
  holders: number[];
  /** Vortex processes launched under this lease. */
  instancePids: number[];
  host: string;
}

export interface LeaseEnv {
  /** Directory holding the lease files. Default: leaseDir(). */
  dir?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface LeaseState {
  lease: Lease;
  live: boolean;
  /** Why a lease is stale, or what keeps it live. */
  reason: string;
}

export function leaseDir(): string {
  const explicit = process.env.VORTEX_AI_LEASE_DIR;
  return explicit !== undefined && explicit !== ""
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".vortex-ai", "leases");
}

/** `--owner`, else VORTEX_AI_OWNER, else "anonymous". */
export function resolveOwner(flag?: string): string {
  const value = flag ?? process.env.VORTEX_AI_OWNER;
  return value === undefined || value.trim() === "" ? ANONYMOUS_OWNER : value.trim();
}

/** The resource key for a Vortex checkout, the same however the path is spelled. */
export function checkoutResource(dir: string): string {
  let resolved = path.resolve(dir);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist yet still gets a stable key.
  }
  resolved = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return `checkout:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
}

function fileFor(dir: string, resource: string): string {
  const safe = resource === INSTANCE_RESOURCE ? resource : (resource.split(":")[0] ?? "resource");
  const suffix =
    resource === INSTANCE_RESOURCE
      ? ""
      : `-${createHash("sha256").update(resource).digest("hex").slice(0, 12)}`;
  return path.join(dir, `${safe}${suffix}.json`);
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering one.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function resolveEnv(env: LeaseEnv = {}): Required<LeaseEnv> {
  return {
    dir: env.dir ?? leaseDir(),
    isAlive: env.isAlive ?? processAlive,
    now: env.now ?? Date.now,
  };
}

export function evaluateLease(lease: Lease, env: LeaseEnv = {}): LeaseState {
  const { isAlive, now } = resolveEnv(env);
  const holders = lease.holders.filter(isAlive);
  const instances = lease.instancePids.filter(isAlive);
  if (lease.mode === "explicit") {
    if (lease.expiresAt !== undefined && Date.parse(lease.expiresAt) <= now()) {
      const running =
        instances.length > 0 ? `; Vortex pid ${instances.join(", ")} still running` : "";
      return { lease, live: false, reason: `expired at ${lease.expiresAt}${running}` };
    }
    if (lease.boundPid !== undefined && !isAlive(lease.boundPid)) {
      return { lease, live: false, reason: `bound process ${String(lease.boundPid)} exited` };
    }
    const until = lease.expiresAt === undefined ? "no expiry" : `until ${lease.expiresAt}`;
    const bound = lease.boundPid === undefined ? "" : `, while pid ${String(lease.boundPid)} runs`;
    return { lease, live: true, reason: `explicit, ${until}${bound}` };
  }
  if (holders.length === 0 && instances.length === 0) {
    const was = [...lease.holders, ...lease.instancePids];
    return {
      lease,
      live: false,
      reason: was.length === 0 ? "no holder recorded" : `holder process ${was.join(", ")} exited`,
    };
  }
  const parts = [
    holders.length > 0 ? `command pid ${holders.join(", ")}` : undefined,
    instances.length > 0 ? `Vortex pid ${instances.join(", ")}` : undefined,
  ].filter((p) => p !== undefined);
  return { lease, live: true, reason: `held by ${parts.join(" and ")}` };
}

function readFile(file: string): Lease | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const lease = parseJson<Lease>(raw);
    lease.holders ??= [];
    lease.instancePids ??= [];
    return lease;
  } catch {
    // A torn or hand-edited file: treat it as absent rather than blocking forever.
    return undefined;
  }
}

function writeFile(file: string, lease: Lease): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // A reader holding the file open makes Windows refuse the replace for a moment.
      if (attempt >= 20) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(25);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding the lease directory's mutex, so read-modify-write is atomic. */
function withMutex<T>(dir: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".mutex");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A mutex older than a few seconds belongs to a process that died mid-update.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) fs.rmSync(lock, { force: true });
      } catch {
        // Removed by its owner meanwhile.
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${lock}; remove it if no vortex-ai is running.`, {
          cause: err,
        });
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export class LeaseHeldError extends ConfigError {
  constructor(
    readonly state: LeaseState,
    readonly requestedBy: string,
  ) {
    super(describeHeld(state, requestedBy));
  }
}

function describeHeld(state: LeaseState, requestedBy: string): string {
  const { lease } = state;
  const what =
    lease.resource === INSTANCE_RESOURCE
      ? "The Vortex instance lease"
      : `The lease on ${lease.resource.slice("checkout:".length)}`;
  const purpose = lease.purpose === undefined ? "" : ` for "${lease.purpose}"`;
  return (
    `${what} is held by "${lease.owner}"${purpose} since ${lease.acquiredAt} ` +
    `(${state.reason}); refusing to act as "${requestedBy}".\n\n` +
    `  See who holds it:   pnpm run ai -- lease status\n` +
    `  Wait for it:        pnpm run ai -- lease run --owner ${requestedBy} --wait 60 -- <command>\n` +
    `  Holder releases:    pnpm run ai -- lease release --owner ${lease.owner}` +
    (lease.resource === INSTANCE_RESOURCE ? `   (or down --owner ${lease.owner})` : "") +
    `\n\n` +
    `Use the same --owner (or VORTEX_AI_OWNER) for every command in one session.`
  );
}

export interface AcquireOptions extends LeaseEnv {
  mode?: LeaseMode;
  purpose?: string;
  /** Holder process to record. Implicit leases default to this process. */
  pid?: number;
  /** Explicit leases: minutes until the lease lapses. 0 or undefined: no expiry. */
  ttlMinutes?: number;
  /** Explicit leases: stay live only while this process runs. */
  boundPid?: number;
}

export interface AcquireResult {
  lease: Lease;
  /** Same owner already held it; this call joined (or renewed) that lease. */
  joined: boolean;
  /** A stale lease that this call replaced, with why it was stale. */
  reclaimed?: LeaseState;
}

export function acquireLease(
  resource: string,
  owner: string,
  options: AcquireOptions = {},
): AcquireResult {
  const env = resolveEnv(options);
  const mode = options.mode ?? "implicit";
  const pid = options.pid ?? (mode === "implicit" ? process.pid : undefined);
  const file = fileFor(env.dir, resource);
  return withMutex(env.dir, () => {
    const nowIso = new Date(env.now()).toISOString();
    const expiresAt =
      mode === "explicit" && options.ttlMinutes !== undefined && options.ttlMinutes > 0
        ? new Date(env.now() + options.ttlMinutes * 60_000).toISOString()
        : undefined;
    const existing = readFile(file);
    let reclaimed: LeaseState | undefined;
    if (existing !== undefined) {
      const state = evaluateLease(existing, env);
      if (state.live) {
        if (existing.owner !== owner) throw new LeaseHeldError(state, owner);
        const joined: Lease = {
          ...existing,
          holders: [
            ...new Set([
              ...existing.holders.filter(env.isAlive),
              ...(pid === undefined ? [] : [pid]),
            ]),
          ],
          instancePids: existing.instancePids.filter(env.isAlive),
          heartbeatAt: nowIso,
        };
        if (mode === "explicit") {
          // Re-acquiring renews: the heartbeat of an explicit lease.
          joined.mode = "explicit";
          joined.expiresAt = expiresAt;
          joined.boundPid = options.boundPid;
          if (options.purpose !== undefined) joined.purpose = options.purpose;
        }
        writeFile(file, joined);
        return { lease: joined, joined: true };
      }
      reclaimed = state;
    }
    const lease: Lease = {
      resource,
      owner,
      mode,
      purpose: options.purpose,
      acquiredAt: nowIso,
      heartbeatAt: nowIso,
      expiresAt,
      boundPid: options.boundPid,
      holders: pid === undefined ? [] : [pid],
      instancePids: [],
      host: os.hostname(),
    };
    writeFile(file, lease);
    return { lease, joined: false, reclaimed };
  });
}

/** Read one lease, evaluated; undefined when nobody holds it. */
export function readLease(resource: string, env: LeaseEnv = {}): LeaseState | undefined {
  const resolved = resolveEnv(env);
  const lease = readFile(fileFor(resolved.dir, resource));
  return lease === undefined ? undefined : evaluateLease(lease, resolved);
}

/** Every lease file, evaluated. */
export function listLeases(env: LeaseEnv = {}): LeaseState[] {
  const resolved = resolveEnv(env);
  let names: string[];
  try {
    names = fs.readdirSync(resolved.dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readFile(path.join(resolved.dir, name)))
    .filter((lease): lease is Lease => lease !== undefined)
    .map((lease) => evaluateLease(lease, resolved));
}

/** Change a lease in place under the mutex; `update` returning undefined deletes it. */
function updateLease(
  resource: string,
  env: LeaseEnv,
  update: (lease: Lease) => Lease | undefined,
): Lease | undefined {
  const resolved = resolveEnv(env);
  const file = fileFor(resolved.dir, resource);
  if (!fs.existsSync(file)) return undefined;
  return withMutex(resolved.dir, () => {
    const lease = readFile(file);
    if (lease === undefined) return undefined;
    const next = update(lease);
    if (next === undefined) fs.rmSync(file, { force: true });
    else writeFile(file, next);
    return next;
  });
}

/** An implicit lease nothing holds any more is garbage. */
function pruned(lease: Lease, env: Required<LeaseEnv>): Lease | undefined {
  const next = {
    ...lease,
    holders: lease.holders.filter(env.isAlive),
    instancePids: lease.instancePids.filter(env.isAlive),
  };
  return next.mode === "implicit" && next.holders.length === 0 && next.instancePids.length === 0
    ? undefined
    : next;
}

/**
 * Give up `pid`'s hold. An implicit lease with nothing else holding it is deleted; one
 * that still has a running Vortex stays, held by that Vortex, until `down`.
 */
export function dropHolder(resource: string, pid: number, env: LeaseEnv = {}): void {
  const resolved = resolveEnv(env);
  updateLease(resource, resolved, (lease) =>
    pruned({ ...lease, holders: lease.holders.filter((p) => p !== pid) }, resolved),
  );
}

export function addInstancePid(resource: string, pid: number, env: LeaseEnv = {}): void {
  updateLease(resource, env, (lease) => ({
    ...lease,
    instancePids: [...new Set([...lease.instancePids, pid])],
  }));
}

export function removeInstancePid(resource: string, pid: number, env: LeaseEnv = {}): void {
  const resolved = resolveEnv(env);
  updateLease(resource, resolved, (lease) =>
    pruned({ ...lease, instancePids: lease.instancePids.filter((p) => p !== pid) }, resolved),
  );
}

export interface ReleaseResult {
  released: boolean;
  /** Why nothing was released. */
  reason?: string;
  /** The Vortex processes still running under the released lease. */
  stillRunning: number[];
  /**
   * A checkout lease was not deleted because a Vortex still runs from it: the explicit hold
   * ended, and the lease stays, held by that Vortex, until it exits.
   */
  keptForRunning?: boolean;
}

/**
 * Release a lease outright. Only its owner may, unless `force` (for a human clearing a
 * lease whose owner is known to be gone but whose recorded process is somehow alive).
 */
export function releaseLease(
  resource: string,
  owner: string,
  options: LeaseEnv & { force?: boolean } = {},
): ReleaseResult {
  const resolved = resolveEnv(options);
  const file = fileFor(resolved.dir, resource);
  if (!fs.existsSync(file)) return { released: false, reason: "not held", stillRunning: [] };
  return withMutex(resolved.dir, () => {
    const lease = readFile(file);
    if (lease === undefined) {
      fs.rmSync(file, { force: true });
      return { released: true, stillRunning: [] };
    }
    const state = evaluateLease(lease, resolved);
    if (lease.owner !== owner && options.force !== true && state.live) {
      return {
        released: false,
        reason: `held by "${lease.owner}", not "${owner}" (pass --force to clear it anyway)`,
        stillRunning: [],
      };
    }
    const running = lease.instancePids.filter(resolved.isAlive);
    if (options.force !== true && running.length > 0 && lease.resource !== INSTANCE_RESOURCE) {
      // A checkout Vortex is running from stays locked until that Vortex exits: releasing
      // an explicit hold must not let someone rebuild or switch it underneath.
      writeFile(file, {
        ...lease,
        mode: "implicit",
        expiresAt: undefined,
        boundPid: undefined,
        holders: lease.holders.filter(resolved.isAlive),
        instancePids: running,
      });
      return { released: true, stillRunning: running, keptForRunning: true };
    }
    fs.rmSync(file, { force: true });
    return { released: true, stillRunning: running };
  });
}

// ---------------------------------------------------------------------------
// Holding a lease for the rest of this process
// ---------------------------------------------------------------------------

/** Leases this process holds, with how many nested holds each has. */
const heldHere = new Map<string, { resource: string; env: LeaseEnv; count: number }>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const { resource, env } of heldHere.values()) {
      try {
        dropHolder(resource, process.pid, env);
      } catch {
        // Best effort at exit; a dead holder makes the lease stale anyway.
      }
    }
  });
}

export interface HoldResult extends AcquireResult {
  /** Stop holding: drop this process as a holder (the lease stays if a Vortex holds it). */
  release: () => void;
}

/**
 * Acquire (or join, for the same owner) an implicit lease held by this process until it
 * exits or `release` is called. Throws LeaseHeldError when another live owner holds it.
 */
export function holdLease(
  resource: string,
  owner: string,
  options: LeaseEnv & { purpose?: string; onReclaim?: (state: LeaseState) => void } = {},
): HoldResult {
  const result = acquireLease(resource, owner, { ...options, mode: "implicit", pid: process.pid });
  if (result.reclaimed !== undefined) options.onReclaim?.(result.reclaimed);
  const key = `${resolveEnv(options).dir}|${resource}`;
  const entry = heldHere.get(key) ?? { resource, env: options, count: 0 };
  entry.count++;
  heldHere.set(key, entry);
  installExitHook();
  let released = false;
  return {
    ...result,
    release: () => {
      if (released) return;
      released = true;
      // A nested hold (a launch inside a runner that already holds it) must not end the
      // outer one.
      entry.count--;
      if (entry.count > 0) return;
      heldHere.delete(key);
      dropHolder(resource, process.pid, entry.env);
    },
  };
}

/** Hold several leases for the duration of `fn`, releasing them however it ends. */
export async function withLeases<T>(
  resources: string[],
  owner: string,
  options: LeaseEnv & { purpose?: string; onReclaim?: (state: LeaseState) => void },
  fn: () => Promise<T>,
): Promise<T> {
  const held: HoldResult[] = [];
  try {
    for (const resource of resources) held.push(holdLease(resource, owner, options));
    return await fn();
  } finally {
    for (const hold of held.toReversed()) hold.release();
  }
}

/** Poll until the lease can be acquired or `waitMs` passes; rethrows the last refusal. */
export async function waitForLease<T>(
  attempt: () => T,
  waitMs: number,
  onWaiting?: (error: LeaseHeldError) => void,
  pollMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  let reported = false;
  for (;;) {
    try {
      return attempt();
    } catch (err) {
      if (!(err instanceof LeaseHeldError) || Date.now() + pollMs > deadline) throw err;
      if (!reported) onWaiting?.(err);
      reported = true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

export function formatLeaseStates(states: LeaseState[]): string {
  if (states.length === 0) return "No leases held.";
  return states
    .map(({ lease, live, reason }) => {
      const lines = [
        `${lease.resource}: ${live ? "HELD" : "STALE"} by "${lease.owner}" (${lease.mode})`,
        `  ${live ? "live" : "stale"}: ${reason}`,
        `  since ${lease.acquiredAt}, heartbeat ${lease.heartbeatAt}`,
      ];
      if (lease.purpose !== undefined) lines.push(`  purpose: ${lease.purpose}`);
      if (!live) lines.push("  the next acquirer reclaims it");
      return lines.join("\n");
    })
    .join("\n");
}
