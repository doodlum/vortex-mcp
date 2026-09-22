/**
 * Deploying and purging a game, as operations a test run can rely on.
 *
 * Installing a mod only stages it; nothing reaches the game directory until
 * deployment links it there. A test that installs a collection and then launches
 * the game without deploying is testing very little, so these are separate,
 * explicit steps rather than something `installCollection` does implicitly.
 *
 * Purging exists here for the same reason a test harness needs `beforeEach`: a
 * run is only repeatable if the game can be put back to a known state first.
 */
import type { VortexMcpClient } from "./mcpClient";
import { autoAnswerDialogs, dialogPolicies, type AnsweredDialog } from "./uiDriver";

export class DeploymentError extends Error {}

export interface DeploymentOptions {
  /** Progress lines, for a CLI to print. */
  onProgress?: (message: string) => void;
  /**
   * Answer "Purge files from different instance?" with **Purge**, deleting files
   * another Vortex instance deployed to this game.
   *
   * Off by default, and never inferred. Vortex blocks deployment outright while
   * a foreign deployment is present, so without this a game another instance has
   * touched simply cannot be deployed to — which is the right default when that
   * other instance is someone's real setup, and the wrong one when the game is a
   * fixture that has to start clean.
   */
  allowForeignPurge?: boolean;
  /**
   * Deploy even while mods are still installing. Off by default.
   *
   * Almost never what you want: a mod is in state from the moment its install
   * starts, so deploying then links a half-extracted set into the game
   * directory and the result looks like a broken collection rather than an
   * unfinished one.
   */
  allowIncomplete?: boolean;
  timeoutMs?: number;
}

interface ModState {
  id: string;
  name?: string;
  state?: string;
}

/**
 * Mods whose installer has not finished.
 *
 * `state` is "installing" from the moment an install begins until its installer
 * completes — which, for a mod with a FOMOD wizard, means until someone answers
 * it. So this is also how an unattended run notices that a dialog is sitting
 * there waiting.
 */
export async function modsStillInstalling(
  mcp: VortexMcpClient,
  gameId: string,
): Promise<ModState[]> {
  const mods = await mcp
    .call<Record<string, ModState> | null>("vortex_query", { path: ["persistent", "mods", gameId] })
    .catch(() => null);
  return Object.values(mods ?? {}).filter((m) => m.state === "installing");
}

/**
 * Remove everything Vortex has deployed to the game directory.
 *
 * `allowFallback` is true: when the deployment manifest is missing or unusable
 * Vortex falls back to working out what to remove by other means. For a fixture
 * being reset that is what you want, since the common reason the manifest is
 * unusable is that a different instance wrote it — exactly the case
 * `allowForeignPurge` is for.
 */
export async function purgeGame(
  mcp: VortexMcpClient,
  options: DeploymentOptions = {},
): Promise<AnsweredDialog[]> {
  return runAnswering(mcp, options, "purge", async (timeoutMs) => {
    await mcp.call(
      "vortex_dispatch",
      { action: "purge-mods", args: [true, "__CALLBACK__"] },
      timeoutMs,
    );
  });
}

/** Link every enabled mod into the game directory. */
export async function deployMods(
  mcp: VortexMcpClient,
  gameId: string,
  options: DeploymentOptions = {},
): Promise<AnsweredDialog[]> {
  if (options.allowIncomplete !== true) {
    const pending = await modsStillInstalling(mcp, gameId);
    if (pending.length > 0) {
      throw new DeploymentError(
        `${String(pending.length)} mod(s) are still installing, so deploying now would link a ` +
          `half-installed set into the game directory:\n` +
          pending.map((m) => `    ${m.name ?? m.id}`).join("\n") +
          `\n\n  An installer dialog is usually what is holding them up. Wait for the ` +
          `install to finish,\n  or pass --allow-incomplete if that is genuinely what you want.\n`,
      );
    }
  }

  return runAnswering(mcp, options, "deploy", async (timeoutMs) => {
    await mcp.call("vortex_dispatch", { action: "deploy-mods", args: ["__CALLBACK__"] }, timeoutMs);
  });
}

/**
 * Run a deployment operation with the dialog watcher alive for its whole span.
 *
 * The watcher has to start *before* the dispatch and outlive it. Both operations
 * block on a modal the moment they hit a foreign deployment, and the dispatch
 * does not resolve until that modal is answered — so answering afterwards
 * deadlocks, and the symptom is an operation that simply never returns.
 */
async function runAnswering(
  mcp: VortexMcpClient,
  options: DeploymentOptions,
  what: string,
  run: (timeoutMs: number) => Promise<void>,
): Promise<AnsweredDialog[]> {
  const report = options.onProgress ?? ((): void => undefined);
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;

  const controller = new AbortController();
  const answering = autoAnswerDialogs(mcp, {
    policies: dialogPolicies({ allowForeignPurge: options.allowForeignPurge }),
    signal: controller.signal,
    pollMs: 1_000,
    onAnswer: (a) => report(`answered [${a.clicked}] ${a.dialog.slice(0, 55)}`),
  });

  try {
    report(`${what} started`);
    await run(timeoutMs);
    report(`${what} finished`);
  } catch (err) {
    throw new DeploymentError(
      `Could not ${what}: ${err instanceof Error ? err.message : String(err)}\n\n` +
        (options.allowForeignPurge === true
          ? "  Check list_dialogs for a modal with no policy."
          : "  If this game holds files from another Vortex instance, deployment is blocked\n" +
            "  until they are purged. Pass --purge to let the harness do that — it deletes\n" +
            "  those files, so it is off by default."),
      { cause: err },
    );
  } finally {
    controller.abort();
  }
  return answering.catch(() => []);
}

/** Whether Vortex still considers this game to have undeployed changes. */
export async function needsDeployment(mcp: VortexMcpClient, gameId: string): Promise<boolean> {
  const pending = await mcp
    .call<Record<string, boolean> | null>("vortex_query", {
      path: ["persistent", "deployment", "needToDeploy"],
    })
    .catch(() => null);
  return pending?.[gameId] === true;
}
