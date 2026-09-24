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

/** What an InstallDriver exposes through getters; every field is optional on purpose. */
export interface DriverLike {
  step?: unknown;
  installDone?: unknown;
  postprocessing?: unknown;
  collection?: { id?: unknown; attributes?: { name?: unknown } } | undefined;
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
  return {
    found: true,
    step: asString(read(() => driver.step)),
    installDone: asBoolean(read(() => driver.installDone)),
    postprocessing: asBoolean(read(() => driver.postprocessing)),
    collectionId: asString(collection?.id),
    collectionName: asString(collection?.attributes?.name),
    installingMod: asString(read(() => driver.installingMod)),
    numRequired: asNumber(read(() => driver.numRequired)),
    revisionId: asNumber(read(() => driver.revisionId)),
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

/** Which collections dialog (by the step it belongs to) an open dialog's text is. */
export function classifyDialog(text: string): string | undefined {
  if (/collection installation (complete|incomplete)/i.test(text)) return "review";
  if (/game version mismatch/i.test(text)) return "game-version-prompt";
  if (/\binstall now\b/i.test(text)) return "query";
  if (/changelog/i.test(text)) return "changelog";
  return undefined;
}
