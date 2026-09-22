/**
 * Installing a Nexus collection, unattended.
 *
 * A collection is not a mod — it is a manifest of mods plus their rules, and
 * Vortex installs it through a driver that downloads each member in turn. The
 * whole flow is gated on being logged in, so this needs an API key; see
 * AGENTS.md.
 *
 * The entry point is the same `start-download` event Vortex's own "Add to
 * Vortex" button uses (collections/index.ts). The `modInfo.nexus.ids` payload
 * is not optional decoration: Vortex recognises a download as a collection by
 * those ids, and without them the collection-completed event never fires and the
 * download sits there looking like an ordinary archive.
 */
import type { VortexMcpClient } from "./mcpClient";
import { autoAnswerDialogs, type AnsweredDialog } from "./uiDriver";

export class CollectionError extends Error {}

export interface CollectionRef {
  gameId: string;
  slug: string;
  /** Omitted means "latest", which Vortex resolves itself. */
  revision?: number;
}

/**
 * Parse the collection URLs people actually have to hand.
 *
 * Accepts the website form (`next.nexusmods.com/<game>/collections/<slug>`,
 * optionally `/revisions/<n>`) and the `nxm://` form the "Add to Vortex" button
 * produces, plus a bare `<game>/<slug>`.
 */
export function parseCollectionRef(input: string): CollectionRef {
  const trimmed = input.trim();

  const nxm = /^nxm:\/\/([^/]+)\/collections\/([^/]+)(?:\/revisions\/(\d+))?/i.exec(trimmed);
  if (nxm?.[1] !== undefined && nxm[2] !== undefined) {
    return {
      gameId: nxm[1],
      slug: nxm[2],
      revision: nxm[3] === undefined ? undefined : Number(nxm[3]),
    };
  }

  const web =
    /nexusmods\.com\/(?:games\/)?([^/]+)\/collections\/([^/?#]+)(?:\/revisions\/(\d+))?/i.exec(
      trimmed,
    );
  if (web?.[1] !== undefined && web[2] !== undefined) {
    return {
      gameId: web[1],
      slug: web[2],
      revision: web[3] === undefined ? undefined : Number(web[3]),
    };
  }

  const bare = /^([a-z0-9]+)\/([A-Za-z0-9_-]+)$/.exec(trimmed);
  if (bare?.[1] !== undefined && bare[2] !== undefined) {
    return { gameId: bare[1], slug: bare[2] };
  }

  throw new CollectionError(
    `Could not read "${input}" as a collection.\n\n` +
      `  Expected one of:\n` +
      `    https://next.nexusmods.com/fallout4/collections/<slug>\n` +
      `    nxm://fallout4/collections/<slug>/revisions/<n>\n` +
      `    fallout4/<slug>`,
  );
}

export function toNxmUrl(ref: CollectionRef): string {
  const base = `nxm://${ref.gameId}/collections/${ref.slug}`;
  return ref.revision === undefined ? base : `${base}/revisions/${String(ref.revision)}`;
}

export interface InstallCollectionOptions {
  /** How long to allow for the whole download+install. Collections are big. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  /** Answer blocking modals automatically. Defaults to true. */
  autoAnswer?: boolean;
}

export interface InstallCollectionResult {
  ref: CollectionRef;
  modId: string | undefined;
  modCount: number;
  answeredDialogs: AnsweredDialog[];
}

interface CollectionMod {
  id: string;
  name?: string;
  type?: string;
  attributes?: { collectionSlug?: string; revisionNumber?: number };
}

/**
 * Download and install a collection, waiting for it to actually finish.
 *
 * "Finished" is judged from state rather than from the download callback: the
 * callback fires when the *collection archive* has downloaded, which is the
 * start of the work, not the end. The driver then pulls down every member mod,
 * which is where the minutes go.
 */
export async function installCollection(
  mcp: VortexMcpClient,
  input: string,
  options: InstallCollectionOptions = {},
): Promise<InstallCollectionResult> {
  const ref = parseCollectionRef(input);
  const report = options.onProgress ?? ((): void => undefined);
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;

  const loggedIn = await mcp.call<boolean>("vortex_query", { selector: "isLoggedIn" });
  if (loggedIn !== true) {
    throw new CollectionError(
      "Not logged in to Nexus Mods, and collections cannot be downloaded anonymously.\n\n" +
        "  Set a personal API key and restart the instance:\n" +
        "    https://next.nexusmods.com/settings/api-keys\n" +
        "    echo 'VORTEX_AI_NEXUS_API_KEY=<key>' >> harness/.env\n" +
        "    pnpm run ai:up --fresh",
    );
  }

  const controller = new AbortController();
  const answering = autoAnswerDialogs(mcp, {
    signal: controller.signal,
    onAnswer: (a) => report(`answered "${a.dialog.slice(0, 60)}..." with "${a.clicked}"`),
  });

  try {
    report(`starting ${toNxmUrl(ref)}`);
    await mcp.call(
      "vortex_dispatch",
      {
        action: "start-download",
        args: [
          [toNxmUrl(ref)],
          {
            game: ref.gameId,
            source: "nexus",
            // Vortex identifies a download as a collection by these ids. The
            // slug and game are all we can know without the GraphQL API; Vortex
            // fills in the rest once it resolves the revision.
            nexus: { ids: { gameId: ref.gameId, collectionSlug: ref.slug } },
          },
          undefined,
          "__CALLBACK__",
        ],
      },
      15 * 60 * 1000,
    );

    report("collection archive downloaded; installing members (this is the slow part)");
    const mod = await waitForCollectionInstalled(mcp, ref, timeoutMs, report);

    return {
      ref,
      modId: mod?.id,
      modCount: await countCollectionMods(mcp, ref.gameId),
      answeredDialogs: await Promise.resolve(answering).catch(() => []),
    };
  } finally {
    controller.abort();
    await answering.catch(() => undefined);
  }
}

/** Poll until a mod of type `collection` matching this slug appears installed. */
async function waitForCollectionInstalled(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  timeoutMs: number,
  report: (message: string) => void,
): Promise<CollectionMod | undefined> {
  const started = Date.now();
  let lastCount = -1;

  for (;;) {
    const mods = await mcp
      .call<Record<string, CollectionMod> | null>("vortex_query", {
        path: ["persistent", "mods", ref.gameId],
      })
      .catch(() => null);

    const all = Object.values(mods ?? {});
    const collection = all.find(
      (m) => m.type === "collection" && m.attributes?.collectionSlug === ref.slug,
    );

    // Surface progress, since a large collection takes long enough that silence
    // is indistinguishable from being stuck.
    if (all.length !== lastCount) {
      lastCount = all.length;
      report(`${String(all.length)} mods present`);
    }

    if (collection !== undefined) return collection;

    if (Date.now() - started > timeoutMs) {
      throw new CollectionError(
        `The collection "${ref.slug}" did not finish installing within ` +
          `${String(Math.round(timeoutMs / 60000))} minutes. ` +
          `${String(all.length)} mods are installed so far — check Vortex's notifications ` +
          `(list_notifications) and any open dialog (list_dialogs).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function countCollectionMods(mcp: VortexMcpClient, gameId: string): Promise<number> {
  const mods = await mcp
    .call<Record<string, CollectionMod> | null>("vortex_query", {
      path: ["persistent", "mods", gameId],
    })
    .catch(() => null);
  return Object.keys(mods ?? {}).length;
}
