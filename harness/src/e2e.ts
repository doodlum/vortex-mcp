/**
 * The whole chain, from nothing to a running game, as one checkable run.
 *
 * Exists because every part of this was verified in isolation and the
 * combination still did not work: a collection reported itself installed while
 * four installers were open, deploy ran over the half-installed set, and the
 * game launched on top of it. Each step looked fine on its own.
 *
 * So every step here asserts against what Vortex itself reports, never against
 * a proxy the harness invented, and the run fails at the first step that cannot
 * prove its own claim.
 */
import { installCollection } from "./collections";
import { bootstrap } from "./bootstrap";
import type { HarnessConfig } from "./config";
import { deployMods, modsStillInstalling, purgeGame } from "./deployment";
import { VortexMcpClient } from "./mcpClient";

export class E2eError extends Error {}

export interface E2eStep {
  name: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

export interface E2eResult {
  steps: E2eStep[];
  ok: boolean;
  elapsedMs: number;
}

export interface E2eOptions {
  collection: string;
  /** Start from a wiped working directory. On by default — that is the point. */
  fresh?: boolean;
  /** Purge files another Vortex instance deployed. Required for a shared game dir. */
  purge?: boolean;
  onProgress?: (message: string) => void;
}

interface CollectionCompleteness {
  name: string;
  complete: boolean;
  required: number;
  satisfied: number;
  unsatisfied: { reference: string; installedButDisabled: boolean }[];
}

export async function runE2e(config: HarnessConfig, options: E2eOptions): Promise<E2eResult> {
  const report = options.onProgress ?? ((): void => undefined);
  const steps: E2eStep[] = [];
  const started = Date.now();

  const step = async (name: string, run: () => Promise<string>): Promise<void> => {
    const t0 = Date.now();
    report(`▶ ${name}`);
    try {
      const detail = await run();
      steps.push({ name, ok: true, detail, elapsedMs: Date.now() - t0 });
      report(`  ✓ ${detail}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ name, ok: false, detail, elapsedMs: Date.now() - t0 });
      report(`  ✗ ${detail}`);
      throw new E2eError(`${name}: ${detail}`);
    }
  };

  let mcp: VortexMcpClient | undefined;

  try {
    await step("start Vortex", async () => {
      const result = await bootstrap(config, {
        fresh: options.fresh !== false,
        onProgress: (m: string) => report(`    ${m}`),
      });
      mcp = result.instance.mcp;
      return `${result.tier} start in ${String(Math.round(result.elapsedMs / 1000))}s`;
    });

    await step("manage the game", async () => {
      const gameId = await mcp?.call<string>("vortex_query", { selector: "activeGameId" });
      if (gameId !== config.gameId) {
        throw new Error(`active game is ${String(gameId)}, expected ${config.gameId}`);
      }
      return `${config.gameId} is active`;
    });

    if (options.purge === true) {
      await step("reset the game directory", async () => {
        await purgeGame(mcp as VortexMcpClient, {
          allowForeignPurge: true,
          onProgress: (m) => report(`    ${m}`),
        });
        return "purged";
      });
    }

    await step("install the collection", async () => {
      const result = await installCollection(mcp as VortexMcpClient, options.collection, {
        onProgress: (m) => report(`    ${m}`),
      });
      if (!result.complete) {
        throw new Error(
          `Vortex reports the collection incomplete ` +
            `(${String(result.modCount)}/${String(result.expectedModCount)})`,
        );
      }
      return `${String(result.modCount)}/${String(result.expectedModCount)} required mods`;
    });

    // Asked again, after the fact. installCollection waits on this same check,
    // so a disagreement here would mean the wait returned early — exactly the
    // failure this run exists to catch.
    await step("confirm Vortex agrees it is complete", async () => {
      const all = await (mcp as VortexMcpClient).call<CollectionCompleteness[]>(
        "collection_status",
        {
          gameId: config.gameId,
        },
      );
      const bad = all.filter((c) => !c.complete);
      if (bad.length > 0) {
        const missing = bad
          .flatMap((c) => c.unsatisfied.map((u) => `${c.name}: ${u.reference}`))
          .join("; ");
        throw new Error(`incomplete after install returned success — ${missing}`);
      }
      const pending = await modsStillInstalling(mcp as VortexMcpClient, config.gameId);
      if (pending.length > 0) {
        throw new Error(`${String(pending.length)} mod(s) still installing`);
      }
      return all.map((c) => `${c.name} ${String(c.satisfied)}/${String(c.required)}`).join(", ");
    });

    await step("deploy", async () => {
      await deployMods(mcp as VortexMcpClient, config.gameId, {
        allowForeignPurge: options.purge === true,
        onProgress: (m) => report(`    ${m}`),
      });
      return "deployed";
    });

    await step("launch the game", async () => {
      // launch_game does not reliably return before the client times out, and
      // the process is the real evidence anyway — so fire it and watch for the
      // game rather than trusting the call's result.
      void (mcp as VortexMcpClient)
        .call("launch_game", { gameId: config.gameId }, 180_000)
        .catch(() => undefined);
      const exe = await waitForGame(config.gameId, 120_000);
      if (exe === undefined) throw new Error("no game process appeared within 2 minutes");
      return `${exe} is running`;
    });
  } finally {
    // The instance is deliberately left running: a failed run is far easier to
    // diagnose with the app still on screen.
  }

  return { steps, ok: steps.every((s) => s.ok), elapsedMs: Date.now() - started };
}

const GAME_EXECUTABLES: Record<string, string[]> = {
  fallout4: ["Fallout4.exe", "f4se_loader.exe"],
  skyrimse: ["SkyrimSE.exe", "skse64_loader.exe"],
  fallout3: ["Fallout3.exe"],
  falloutnv: ["FalloutNV.exe"],
};

async function waitForGame(gameId: string, timeoutMs: number): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const names = GAME_EXECUTABLES[gameId] ?? [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const name of names) {
      const found = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], {
        windowsHide: true,
      })
        .then(({ stdout }) => stdout.toLowerCase().includes(name.toLowerCase()))
        .catch(() => false);
      if (found) return name;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return undefined;
}
