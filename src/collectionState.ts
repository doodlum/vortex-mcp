/**
 * Where a collection install is, read from outside Vortex's collections extension.
 *
 * Vortex keeps its collection `InstallDriver` in a module-level variable of the
 * collections extension; `registerAPI` exposes only the install *session*
 * (`getActiveCollectionInstallSession`, the same object as
 * `state.session.collections.activeSession`), not the driver's step. The step decides
 * which dialog is showing (`query` → Install Now, `review` → the review screen) and
 * whether an update auto-continues (`start`), so tests and fix agents keep needing it.
 *
 * The driver does reach one place an extension can read: it is passed as the `driver`
 * prop to the collections extension's always-mounted dialogs (`collection-install`,
 * `collection-finish`). So this walks React's fiber tree from the app's root and reads
 * that prop. Read-only, stock-compatible, but a private shape: when Vortex stops passing
 * the prop, `driver.found` is false with a reason, and the session state and open dialogs
 * (which are public) are still reported.
 */

/** The part of a React fiber this reads. */
export interface FiberLike {
  child?: FiberLike | null;
  sibling?: FiberLike | null;
  return?: FiberLike | null;
  tag?: number;
  memoizedProps?: unknown;
}

interface CollectionLike {
  id?: unknown;
  type?: unknown;
  attributes?: { name?: unknown; customFileName?: unknown };
}

/** A collection's display name as Vortex renders it: the custom name, else its name. */
const displayName = (collection: CollectionLike | undefined): string | undefined =>
  asString(collection?.attributes?.customFileName) ?? asString(collection?.attributes?.name);

/** What an InstallDriver exposes through getters; every field is optional on purpose. */
export interface DriverLike {
  step?: unknown;
  installDone?: unknown;
  postprocessing?: unknown;
  collection?: CollectionLike | undefined;
  lastCollection?: CollectionLike | undefined;
  /** Private: the chain `prepare()` queues on; a Bluebird promise with `isPending()`. */
  mPrepare?: unknown;
  /** Private, on builds with the game-version Cancel fix: the start attempt in progress. */
  mStarting?: unknown;
  installingMod?: unknown;
  numRequired?: unknown;
  revisionId?: unknown;
  onUpdate?: unknown;
  continue?: unknown;
}

const MAX_FIBERS = 500_000;

function isDriver(value: unknown): value is DriverLike {
  if (value === null || typeof value !== "object") return false;
  const driver = value as DriverLike;
  return (
    typeof driver.onUpdate === "function" &&
    typeof driver.continue === "function" &&
    "step" in driver
  );
}

/** The fiber attached to a DOM element by React (`__reactFiber$…` or, before 17, `__reactInternalInstance$…`). */
export function fiberOf(element: object): FiberLike | undefined {
  const record = element as Record<string, unknown>;
  for (const key of Object.keys(element)) {
    if (
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$") ||
      // A root container created by createRoot holds its root fiber here.
      key.startsWith("__reactContainer$")
    ) {
      return record[key] as FiberLike;
    }
  }
  // A container rendered with the legacy ReactDOM.render.
  const legacy = record._reactRootContainer as
    | { _internalRoot?: { current?: FiberLike }; current?: FiberLike }
    | undefined;
  return legacy?._internalRoot?.current ?? legacy?.current;
}

/** Depth-first search of a fiber tree for the first `driver` prop that looks like an InstallDriver. */
export function findDriver(root: FiberLike): { driver?: DriverLike; visited: number } {
  const stack: FiberLike[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_FIBERS) {
    const fiber = stack.pop();
    if (fiber === undefined) continue;
    visited++;
    const props = fiber.memoizedProps as { driver?: unknown } | null | undefined;
    if (props !== null && typeof props === "object" && isDriver(props.driver)) {
      return { driver: props.driver, visited };
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return { visited };
}

/** The root of the tree an element's fiber belongs to. */
export function rootOf(fiber: FiberLike): FiberLike {
  let node = fiber;
  let guard = 0;
  while (node.return && guard++ < 100_000) node = node.return;
  return node;
}

export interface DriverState {
  found: boolean;
  /** Why the driver could not be read, when found is false. */
  reason?: string;
  step?: string;
  installDone?: boolean;
  postprocessing?: boolean;
  collectionId?: string;
  collectionName?: string;
  installingMod?: string;
  numRequired?: number;
  revisionId?: number;
  /**
   * Work queued with `driver.prepare()` has not finished: `start()` and `query()` wait for it
   * before doing anything. Null when not observable (the chain is not a Bluebird promise).
   */
  preparing?: boolean | null;
  /**
   * A start attempt is in progress (startInstall has not returned: the revision fetch, the
   * game-version prompt). Read from the private `mStarting` token, which only builds with the
   * game-version Cancel fix have; null elsewhere, or before the first start.
   */
  starting?: boolean | null;
  /** The last collection the driver worked on, which the review screen shows after it ends. */
  lastCollectionId?: string;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const asBoolean = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/** Read the getters defensively: any of them can throw on a half-set-up driver. */
export function describeDriver(driver: DriverLike): DriverState {
  const collection = read(() => driver.collection);
  const prepare = read(() => driver.mPrepare) as { isPending?: () => unknown } | undefined;
  const pending =
    typeof prepare?.isPending === "function" ? read(() => prepare.isPending?.()) : undefined;
  return {
    found: true,
    step: asString(read(() => driver.step)),
    installDone: asBoolean(read(() => driver.installDone)),
    postprocessing: asBoolean(read(() => driver.postprocessing)),
    collectionId: asString(collection?.id),
    collectionName: displayName(collection),
    installingMod: asString(read(() => driver.installingMod)),
    numRequired: asNumber(read(() => driver.numRequired)),
    revisionId: asNumber(read(() => driver.revisionId)),
    preparing: typeof pending === "boolean" ? pending : null,
    starting: "mStarting" in driver ? read(() => driver.mStarting) !== undefined : null,
    lastCollectionId: asString(read(() => driver.lastCollection)?.id),
  };
}

let cached: DriverLike | undefined;

/** Find the collections extension's InstallDriver in the rendered app (cached once found). */
export function readDriver(doc: Document | undefined = globalThis.document): DriverState {
  if (cached !== undefined) return describeDriver(cached);
  if (doc === undefined) return { found: false, reason: "no document (not in a renderer)" };
  const content = doc.getElementById("content");
  const starts = [content, content?.firstElementChild, doc.body?.firstElementChild].filter(
    (e): e is Element => e !== null && e !== undefined,
  );
  const fiber = starts.map(fiberOf).find((f) => f !== undefined);
  if (fiber === undefined)
    return { found: false, reason: "no React fiber on the app's root element" };
  const { driver, visited } = findDriver(rootOf(fiber));
  if (driver === undefined) {
    return {
      found: false,
      reason:
        `no component has a driver prop (searched ${String(visited)} fibers); this Vortex ` +
        "does not pass the InstallDriver to its collection dialogs",
    };
  }
  cached = driver;
  return describeDriver(driver);
}

/** For tests. */
export function resetDriverCache(): void {
  cached = undefined;
}

interface SessionMod {
  status?: unknown;
  type?: unknown;
  modId?: unknown;
  rule?: { reference?: { tag?: unknown; description?: unknown } };
}

export interface SessionSummary {
  sessionId?: string;
  collectionId?: string;
  gameId?: string;
  /** Members by status (pending, downloading, installing, installed, failed, ignored, …). */
  statusCounts: Record<string, number>;
  /** Members by rule type (requires, recommends). */
  typeCounts: Record<string, number>;
  /** Up to 50 members that are not installed or ignored, with their status. */
  outstanding: { id: string; status: string; type?: string }[];
  /** The session's other scalar fields (totals, phase, timestamps), as Vortex keeps them. */
  fields: Record<string, unknown>;
}

/** Summarise `state.session.collections.activeSession` without its per-member detail. */
export function summariseSession(session: unknown): SessionSummary | null {
  if (session === null || session === undefined || typeof session !== "object") return null;
  const s = session as Record<string, unknown> & { mods?: Record<string, SessionMod> };
  const statusCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  const outstanding: SessionSummary["outstanding"] = [];
  for (const [id, mod] of Object.entries(s.mods ?? {})) {
    const status = asString(mod?.status) ?? "unknown";
    const type = asString(mod?.type);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (type !== undefined) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    if (status !== "installed" && status !== "ignored" && outstanding.length < 50) {
      outstanding.push({ id, status, type });
    }
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    if (key === "mods") continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value))
      fields[key] = value;
  }
  return {
    sessionId: asString(s.sessionId),
    collectionId: asString(s.collectionId),
    gameId: asString(s.gameId),
    statusCounts,
    typeCounts,
    outstanding,
    fields,
  };
}

export interface DialogCollection {
  collectionId: string | null;
  collectionName: string | null;
  /**
   * How it was found: the `driver` prop of the component rendering the dialog (its collection,
   * or its last one once the install ended), a `collection` prop, or the dialog's text naming
   * an installed collection. Null when none says.
   */
  via: "driver" | "collection-prop" | "text" | null;
}

const isCollection = (value: unknown): value is CollectionLike =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as CollectionLike).id === "string" &&
  (value as CollectionLike).type === "collection";

/**
 * Which collection an open dialog belongs to. Walks up from the dialog's element through React's
 * fiber tree to the first component with a `driver` (an InstallDriver) or a `collection` prop.
 * Dialogs raised with `showDialog` (the game-version prompt) have neither; for those the
 * dialog's text is matched against the installed collections' names, longest first.
 */
export function dialogCollection(
  element: object,
  collections: Array<{ id: string; name: string }> = [],
  text = "",
): DialogCollection {
  let fiber: FiberLike | null | undefined = fiberOf(element);
  for (let depth = 0; fiber !== undefined && fiber !== null && depth < 300; depth++) {
    const props = fiber.memoizedProps as { driver?: unknown; collection?: unknown } | null;
    if (props !== null && typeof props === "object") {
      if (isDriver(props.driver)) {
        const driver = props.driver;
        const collection = read(() => driver.collection) ?? read(() => driver.lastCollection);
        if (collection !== undefined) {
          return {
            collectionId: asString(collection.id) ?? null,
            collectionName: displayName(collection) ?? null,
            via: "driver",
          };
        }
      }
      if (isCollection(props.collection)) {
        return {
          collectionId: asString(props.collection.id) ?? null,
          collectionName: displayName(props.collection) ?? null,
          via: "collection-prop",
        };
      }
    }
    fiber = fiber.return;
  }
  const named = collections
    .filter((c) => c.name !== "" && text.includes(c.name))
    .toSorted((a, b) => b.name.length - a.name.length)[0];
  return named === undefined
    ? { collectionId: null, collectionName: null, via: null }
    : { collectionId: named.id, collectionName: named.name, via: "text" };
}

/** The installed collections of every game, by id and display name, for `dialogCollection`. */
export function installedCollections(mods: unknown): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  if (mods === null || typeof mods !== "object") return out;
  for (const game of Object.values(mods as Record<string, unknown>)) {
    if (game === null || typeof game !== "object") continue;
    for (const [id, mod] of Object.entries(game as Record<string, CollectionLike>)) {
      if (mod?.type !== "collection") continue;
      out.push({ id, name: displayName(mod) ?? id });
    }
  }
  return out;
}

/** Which collections dialog (by the step it belongs to) an open dialog's text is. */
export function classifyDialog(text: string): string | undefined {
  if (/collection installation (complete|incomplete)/i.test(text)) return "review";
  if (/game version mismatch/i.test(text)) return "game-version-prompt";
  // Button texts run together ("LaterInstall Now": no word boundary before it), and the text
  // is cut at 400 characters, which can drop that last button; the heading comes first.
  if (/install now\b/i.test(text) || /collection added/i.test(text)) return "query";
  if (/changelog/i.test(text)) return "changelog";
  return undefined;
}
