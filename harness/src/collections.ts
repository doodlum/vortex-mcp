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
import { autoAdvanceFomods, autoAnswerDialogs, clickByName, type AnsweredDialog } from "./uiDriver";

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

export interface ResolvedCollection extends CollectionRef {
  collectionId: number;
  revisionId: number;
  revisionNumber: number;
  name: string;
  modCount: number;
}

/**
 * Look the collection up on Nexus to get its real ids.
 *
 * Vortex's own "Add to Vortex" button passes collectionId, revisionId and
 * revisionNumber alongside the nxm URL, and it needs them: given only a slug the
 * download never resolves — no error, no download, nothing at all, which is a
 * miserable thing to debug. This is the public GraphQL API and needs no token,
 * so resolution works before the instance is even logged in.
 */
export async function resolveCollection(ref: CollectionRef): Promise<ResolvedCollection> {
  const query = `query { collection(slug: "${ref.slug}", domainName: "${ref.gameId}", viewAdultContent: true) { id slug name currentRevision { id revisionNumber modCount } } }`;

  const response = await fetch("https://api.nexusmods.com/v2/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vortex-mcp-harness/1.0" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new CollectionError(
      `Nexus returned ${String(response.status)} looking up ${ref.gameId}/${ref.slug}.`,
    );
  }

  const body = (await response.json()) as {
    data?: {
      collection?: {
        id: number;
        name: string;
        currentRevision?: { id: number; revisionNumber: number; modCount: number };
      } | null;
    };
    errors?: { message: string }[];
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new CollectionError(`Nexus rejected the lookup: ${body.errors[0]?.message ?? "unknown"}`);
  }
  const collection = body.data?.collection;
  if (collection == null || collection.currentRevision == null) {
    throw new CollectionError(
      `No collection "${ref.slug}" for ${ref.gameId} on Nexus. Check the URL — the slug is the ` +
        `short code at the end, e.g. .../collections/pmmttm.`,
    );
  }

  return {
    ...ref,
    collectionId: collection.id,
    revisionId: collection.currentRevision.id,
    revisionNumber: ref.revision ?? collection.currentRevision.revisionNumber,
    name: collection.name,
    modCount: collection.currentRevision.modCount,
  };
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
  /** Member mods actually installed. */
  modCount: number;
  /** Members the collection *requires*; optional ones are not counted. */
  expectedModCount: number;
  complete: boolean;
  answeredDialogs: AnsweredDialog[];
}

interface CollectionRule {
  /** "requires" for a member that must install, "recommends" for an optional one. */
  type: string;
  reference: { description?: string; logicalFileName?: string };
}

interface CollectionMod {
  id: string;
  name?: string;
  type?: string;
  /** "installing" until the installer finishes, then "installed". */
  state?: string;
  attributes?: { collectionSlug?: string; revisionNumber?: number };
  rules?: CollectionRule[];
}

/**
 * How many member mods installing this collection should actually produce.
 *
 * Nexus's `modCount` counts everything the collection lists, optional mods
 * included, and Vortex only installs the required ones. Waiting for `modCount`
 * therefore waits for mods that are never coming: the FallUI Series collection
 * reports 11 and installs 8, so a complete install looked like a stall and then
 * a timeout. The collection mod's own `requires` rules are what Vortex works
 * from, so count those and fall back to `modCount` only before they exist.
 */
function requiredMemberCount(collectionMod: CollectionMod, fallback: number): number {
  const required = (collectionMod.rules ?? []).filter((r) => r.type === "requires");
  return required.length > 0 ? required.length : fallback;
}

/**
 * Download and install a collection, waiting for it to actually finish.
 *
 * Four steps, and skipping any of them leaves the collection looking installed
 * when it is not:
 *
 *   1. Resolve the collection on Nexus for its real ids.
 *   2. Download it. This installs the *collection mod* — a manifest — and
 *      nothing else. Vortex reports "Collection incomplete" at this point.
 *   3. Start the install driver, which is what pulls down the member mods. The
 *      UI gates this behind an "Install Now" button; there is no event that
 *      skips it, so the harness clicks it.
 *   4. Wait for the members. The download callback fires at the end of step 2,
 *      so treating it as completion is the mistake that makes a collection look
 *      installed with zero mods in it.
 *
 * Blocking modals are answered throughout, not at fixed points: the version
 * mismatch appears before the first mod, the purge prompt partway through, and
 * a cancellation confirm can appear at any time.
 */
export async function installCollection(
  mcp: VortexMcpClient,
  input: string,
  options: InstallCollectionOptions = {},
): Promise<InstallCollectionResult> {
  const ref = parseCollectionRef(input);
  const report = options.onProgress ?? ((): void => undefined);
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;

  // `isLoggedIn` is not the right question here. Vortex defines it as
  // `truthy(APIKey) || truthy(OAuthCredentials)`, so an API key alone satisfies
  // it — but this build authenticates collection downloads with OAuth, and an
  // API key gets a 401 surfaced as "You are not logged in to Nexus Mods!" well
  // after the download has been dispatched. Ask for what is actually needed.
  const oauth = await mcp
    .call<unknown>("vortex_query", {
      path: ["confidential", "account", "nexus", "OAuthCredentials"],
    })
    .catch(() => undefined);
  if (oauth === undefined || oauth === null) {
    throw new CollectionError(
      "Not signed in to Nexus with OAuth, and collection downloads require it on this\n" +
        "Vortex build. An API key is NOT enough: it satisfies Vortex's isLoggedIn check,\n" +
        "so the download starts and then fails with a 401.\n\n" +
        "  Sign in through Vortex's own Log in button — the OAuth flow has a captcha,\n" +
        "  so it cannot be automated and the user has to do it once.\n\n" +
        "  Then run `vortex-ai save-login` once: it folds the signed-in instance\n" +
        "  into the snapshot, so cold starts restore the login instead of losing it.\n",
    );
  }

  const controller = new AbortController();
  const answering = autoAnswerDialogs(mcp, {
    signal: controller.signal,
    pollMs: 1_500,
    onAnswer: (a) => report(`answered [${a.clicked}] ${a.dialog.slice(0, 55)}`),
    onUnanswerable: (d, wanted) =>
      report(`STUCK: no button matching ${wanted} in "${d.slice(0, 60)}"`),
  });
  // Member mods ship FOMOD installers that block the driver until someone picks
  // options. Unattended is the whole point of this function, so accept their
  // defaults; the collection manifest already encodes the curator's choices.
  const advancing = autoAdvanceFomods(mcp, {
    signal: controller.signal,
    onAdvance: (label) => report(`fomod step [${label}]`),
  });

  try {
    const resolved = await resolveCollection(ref);
    report(
      `${resolved.name} — revision ${String(resolved.revisionNumber)}, ${String(resolved.modCount)} mods`,
    );

    const existing = await findCollectionMod(mcp, ref);
    if (existing === undefined) {
      const url = toNxmUrl({ ...ref, revision: resolved.revisionNumber });
      report(`downloading ${url}`);
      await startCollectionDownload(mcp, ref, resolved, url);
      await waitForCollectionMod(mcp, ref, 15 * 60 * 1000, report);
    } else {
      report("collection already added; resuming its install");
    }

    const collectionMod = await waitForCollectionMod(mcp, ref, 60_000, report);
    await startInstallDriver(mcp, ref, collectionMod.id, report);

    const expected = requiredMemberCount(collectionMod, resolved.modCount);
    if (expected !== resolved.modCount) {
      report(`${String(expected)} of the ${String(resolved.modCount)} listed mods are required`);
    }
    const status = await waitForCompletion(mcp, ref, timeoutMs, report);

    return {
      ref,
      modId: collectionMod.id,
      modCount: status.satisfied,
      expectedModCount: status.required,
      complete: status.complete,
      answeredDialogs: [],
    };
  } finally {
    controller.abort();
    await answering.catch(() => undefined);
    await advancing.catch(() => undefined);
  }
}

async function startCollectionDownload(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  resolved: ResolvedCollection,
  url: string,
): Promise<void> {
  await mcp.call(
    "vortex_dispatch",
    {
      action: "start-download",
      args: [
        [url],
        {
          game: ref.gameId,
          source: "nexus",
          name: resolved.name,
          // Exactly what Vortex's own "Add to Vortex" button sends. These ids
          // are what make it a *collection* download rather than an archive.
          nexus: {
            ids: {
              gameId: ref.gameId,
              collectionId: resolved.collectionId,
              revisionId: resolved.revisionId,
              collectionSlug: ref.slug,
              revisionNumber: resolved.revisionNumber,
            },
          },
        },
        // fileName. Vortex's own collections code passes `undefined`, but newer
        // builds validate this event's arguments with zod and require a string —
        // and a rejected argument list means the handler never runs, so the
        // download silently never starts and the awaited callback never fires.
        `${ref.slug}-rev${String(resolved.revisionNumber)}.7z`,
        "__CALLBACK__",
      ],
    },
    15 * 60 * 1000,
  );
}

/**
 * Get the install driver moving.
 *
 * `resume-collection` is the event Vortex's own "Resume" notification uses, but
 * it refuses with "already installing a collection" when a session is live — so
 * a failure here is frequently the good case, and the "Install Now" click is
 * what actually matters. The button only exists while the driver is waiting for
 * confirmation, so its absence is equally fine.
 */
async function startInstallDriver(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  modId: string,
  report: (message: string) => void,
): Promise<void> {
  await mcp
    .call("vortex_dispatch", { action: "resume-collection", args: [ref.gameId, modId] }, 120_000)
    .catch(() => undefined);

  await new Promise((resolve) => setTimeout(resolve, 4_000));

  const clicked = await clickByName(mcp, { role: "button", name: /^install now$/i })
    .then(() => true)
    .catch(() => false);
  report(clicked ? "clicked Install Now" : "driver already running (no Install Now button)");
}

async function findCollectionMod(
  mcp: VortexMcpClient,
  ref: CollectionRef,
): Promise<CollectionMod | undefined> {
  const mods = await mcp
    .call<Record<string, CollectionMod> | null>("vortex_query", {
      path: ["persistent", "mods", ref.gameId],
    })
    .catch(() => null);
  return Object.values(mods ?? {}).find((m) => m.type === "collection");
}

async function waitForCollectionMod(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  timeoutMs: number,
  report: (message: string) => void,
): Promise<CollectionMod> {
  const started = Date.now();
  for (;;) {
    const found = await findCollectionMod(mcp, ref);
    if (found !== undefined) return found;
    if (Date.now() - started > timeoutMs) {
      throw new CollectionError(
        `The collection archive for "${ref.slug}" never finished downloading. ` +
          `Check list_notifications and list_dialogs — a modal may be waiting.`,
      );
    }
    report("waiting for the collection archive");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

export interface CollectionRuleStatus {
  reference: string;
  modId?: string;
  satisfied: boolean;
  installedButDisabled: boolean;
}

export interface CollectionCompleteness {
  collectionModId: string;
  name: string;
  complete: boolean;
  required: number;
  satisfied: number;
  unsatisfied: CollectionRuleStatus[];
}

/**
 * Wait until Vortex itself calls the collection complete.
 *
 * Counting installed mods is not the same question, and getting that wrong is
 * what made this report success on a half-finished install. Vortex resolves
 * every required rule through its own reference matcher and additionally
 * requires the matched mod to be enabled in the active profile, so a collection
 * can have every member installed, correctly named, with nothing left
 * installing — and still be Incomplete.
 *
 * `collection_status` runs that exact check inside the app, so this waits on
 * the same answer the Collections page displays rather than a proxy for it.
 */
async function waitForCompletion(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  timeoutMs: number,
  report: (message: string) => void,
): Promise<CollectionCompleteness> {
  const started = Date.now();
  let last = "";
  let lastChange = Date.now();

  for (;;) {
    const all = await mcp
      .call<CollectionCompleteness[]>("collection_status", { gameId: ref.gameId })
      .catch(() => [] as CollectionCompleteness[]);
    const status = all[0];

    if (status !== undefined) {
      if (status.complete) {
        report(`${String(status.satisfied)}/${String(status.required)} required mods — complete`);
        return status;
      }
      const line = `${String(status.satisfied)}/${String(status.required)} required mods satisfied`;
      if (line !== last) {
        last = line;
        lastChange = Date.now();
        report(line);
      }
    }

    if (Date.now() - started > timeoutMs) {
      const missing = (status?.unsatisfied ?? [])
        .map(
          (u) => `    ${u.reference}${u.installedButDisabled ? "  (installed but disabled)" : ""}`,
        )
        .join("\n");
      throw new CollectionError(
        `"${ref.slug}" is still incomplete after ` +
          `${String(Math.round(timeoutMs / 60000))} minutes.\n\n` +
          `  Vortex still considers these rules unsatisfied:\n${missing}\n\n` +
          `  "installed but disabled" means the mod is there and switched off, which satisfies\n` +
          `  nothing; anything else never installed. Check list_dialogs for an installer waiting\n` +
          `  on input, and list_notifications for failures.\n`,
      );
    }

    // A long stall almost always means a modal appeared that no policy matched.
    if (Date.now() - lastChange > 5 * 60 * 1000) {
      lastChange = Date.now();
      report(`no progress for 5 minutes at ${last} — check for a modal`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
