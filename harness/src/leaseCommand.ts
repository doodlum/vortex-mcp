/**
 * `vortex-ai lease run --owner X -- <command...>`: run any command holding the leases.
 *
 * This is how things the kit does not launch itself (`pnpm run verify`, an ad-hoc script,
 * Vortex's E2E suite by hand) are serialized with everything that does. The child gets
 * VORTEX_AI_OWNER, so kit commands inside it join the lease rather than refusing.
 */
import { spawn } from "node:child_process";

import {
  holdLease,
  waitForLease,
  type HoldResult,
  type LeaseEnv,
  type LeaseHeldError,
  type LeaseState,
} from "./lease";

export interface RunUnderLeaseOptions {
  command: string;
  args: string[];
  owner: string;
  resources: string[];
  purpose?: string;
  /** How long to wait for another owner's lease to end. 0: refuse at once. */
  waitMs?: number;
  leaseEnv?: LeaseEnv;
  cwd?: string;
  /** Run through the shell (default on Windows, where pnpm and friends are .cmd files). */
  shell?: boolean;
  /** Extra environment for the command, on top of this process's and VORTEX_AI_OWNER. */
  env?: NodeJS.ProcessEnv;
  onWaiting?: (error: LeaseHeldError) => void;
  onReclaim?: (state: LeaseState) => void;
}

function quoteForShell(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** Acquire, run with inherited stdio, release however it ends; resolves to its exit code. */
export async function runUnderLease(options: RunUnderLeaseOptions): Promise<number> {
  const held: HoldResult[] = [];
  const holdAll = (): void => {
    for (const resource of options.resources.slice(held.length)) {
      held.push(
        holdLease(resource, options.owner, {
          ...options.leaseEnv,
          purpose: options.purpose ?? `lease run: ${options.command} ${options.args.join(" ")}`,
          onReclaim: options.onReclaim,
        }),
      );
    }
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  let child: ReturnType<typeof spawn> | undefined;
  // Ctrl+C reaches the child through the console; keep this process alive until the
  // child has exited, so the lease is released after it rather than under it.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signal !== "SIGINT") child?.kill(signal);
  };
  try {
    await waitForLease(holdAll, options.waitMs ?? 0, options.onWaiting);
    signals.forEach((s) => process.on(s, onSignal));
    const shell = options.shell ?? process.platform === "win32";
    return await new Promise<number>((resolve, reject) => {
      child = spawn(
        shell ? [options.command, ...options.args].map(quoteForShell).join(" ") : options.command,
        shell ? [] : options.args,
        {
          cwd: options.cwd,
          stdio: "inherit",
          shell,
          env: { ...process.env, ...options.env, VORTEX_AI_OWNER: options.owner },
        },
      );
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
    });
  } finally {
    signals.forEach((s) => process.removeListener(s, onSignal));
    for (const hold of held.toReversed()) hold.release();
  }
}
