/**
 * Finding and acting on UI elements by what they say, not by CSS.
 *
 * `ui_click` takes a `ref` or a CSS selector, and neither is much use on their
 * own for "click the button labelled Manage": refs come from a snapshot, and
 * Vortex's class names are largely generated and not stable across builds. This
 * module closes that gap — snapshot, search the tree by role/name/text, act on
 * the match — which is the loop an agent performs by hand, and which the harness
 * needs internally for the bootstrap flow.
 *
 * Kept here rather than in the extension deliberately: the extension's job is to
 * expose primitives faithfully, and a fuzzy text search that silently picks
 * "the first plausible match" is a policy decision better made where it can be
 * seen and adjusted.
 */
import type { VortexMcpClient } from "./mcpClient";

export interface SnapshotNode {
  ref: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  disabled?: boolean;
  checked?: boolean;
  children?: SnapshotNode[];
}

export interface Snapshot {
  generation: number;
  title: string;
  viewport: { width: number; height: number };
  nodeCount: number;
  truncated: boolean;
  activeDialogs: string[];
  tree: SnapshotNode[];
}

export interface NodeQuery {
  /** Exact role, e.g. "button", "textbox", "link". */
  role?: string;
  /** Case-insensitive substring of the accessible name or visible text. */
  name?: string | RegExp;
  /** Exact data-testid. */
  testId?: string;
  /** Skip disabled elements. Defaults to true. */
  enabledOnly?: boolean;
}

export function flatten(nodes: SnapshotNode[]): SnapshotNode[] {
  const out: SnapshotNode[] = [];
  const walk = (list: SnapshotNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function matches(node: SnapshotNode, query: NodeQuery): boolean {
  if (query.testId !== undefined && node.testId !== query.testId) return false;
  if (query.role !== undefined && node.role !== query.role) return false;
  if (query.enabledOnly !== false && node.disabled === true) return false;

  if (query.name !== undefined) {
    const haystack = `${node.name ?? ""} ${node.text ?? ""}`.trim();
    if (query.name instanceof RegExp) {
      if (!query.name.test(haystack)) return false;
    } else if (!haystack.toLowerCase().includes(query.name.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function findNodes(snap: Snapshot, query: NodeQuery): SnapshotNode[] {
  return flatten(snap.tree).filter((node) => matches(node, query));
}

export class ElementNotFoundError extends Error {}

/**
 * Find exactly one node, or explain what was there instead.
 *
 * The error lists nearby candidates, because "no element matching Manage" is
 * almost never actionable on its own — what you need to know is whether the
 * button is absent, differently labelled, or disabled.
 */
export function findOne(snap: Snapshot, query: NodeQuery): SnapshotNode {
  const found = findNodes(snap, query);
  if (found.length > 0) return found[0] as SnapshotNode;

  const sameRole =
    query.role === undefined
      ? []
      : findNodes(snap, { role: query.role, enabledOnly: false })
          .map((n) => n.name ?? n.text ?? "(unnamed)")
          .slice(0, 25);

  throw new ElementNotFoundError(
    `No ${query.role ?? "element"} matching ${JSON.stringify(String(query.name ?? query.testId))}.` +
      (sameRole.length > 0 ? `\n  ${query.role}s present: ${sameRole.join(", ")}` : "") +
      (snap.activeDialogs.length > 0
        ? `\n  A modal is open, which may be covering it: ${snap.activeDialogs[0]?.slice(0, 200) ?? ""}`
        : ""),
  );
}

export async function snapshot(mcp: VortexMcpClient, selector?: string): Promise<Snapshot> {
  return mcp.call<Snapshot>("ui_snapshot", selector === undefined ? {} : { selector });
}

/**
 * Snapshot, find one node, and click it.
 *
 * Always re-snapshots rather than reusing a caller's: refs are invalidated by
 * the next snapshot, so acting on a ref the caller obtained earlier is exactly
 * the stale-ref hazard the extension guards against.
 */
export async function clickByName(mcp: VortexMcpClient, query: NodeQuery): Promise<SnapshotNode> {
  const node = findOne(await snapshot(mcp), query);
  await mcp.call("ui_click", { ref: node.ref });
  return node;
}

export async function hoverByName(mcp: VortexMcpClient, query: NodeQuery): Promise<SnapshotNode> {
  const node = findOne(await snapshot(mcp), query);
  await mcp.call("ui_hover", { ref: node.ref });
  return node;
}

export async function fillByName(
  mcp: VortexMcpClient,
  query: NodeQuery,
  value: string,
): Promise<SnapshotNode> {
  const node = findOne(await snapshot(mcp), query);
  await mcp.call("ui_fill", { ref: node.ref, value });
  return node;
}

/**
 * Poll snapshots until a node matching the query appears.
 *
 * `ui_wait_for` handles selectors and raw text; this handles role+name, which
 * is what you actually want after an action that renders a new control.
 */
export async function waitForNode(
  mcp: VortexMcpClient,
  query: NodeQuery,
  timeoutMs = 30_000,
): Promise<SnapshotNode> {
  const started = Date.now();
  let last: Snapshot | undefined;
  for (;;) {
    last = await snapshot(mcp);
    const found = findNodes(last, query);
    if (found.length > 0) return found[0] as SnapshotNode;
    if (Date.now() - started > timeoutMs) {
      return findOne(last, query); // throws with the useful candidate list
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Dismiss any open modal with Escape, and report whether one was there. */
export async function dismissDialogs(mcp: VortexMcpClient): Promise<string[]> {
  const snap = await snapshot(mcp);
  if (snap.activeDialogs.length === 0) return [];
  await mcp.call("ui_press_key", { key: "Escape" });
  return snap.activeDialogs;
}

// ---------------------------------------------------------------------------
// Automatic dialog answering
// ---------------------------------------------------------------------------

export interface DialogPolicy {
  /** Matched against the modal's visible text. */
  match: RegExp;
  /** Label of the button to click. */
  button: string | RegExp;
  /** Why this answer is the right default — surfaced when it fires. */
  because: string;
}

/**
 * Dialogs the harness knows how to answer unattended, and what it picks.
 *
 * Every default here is the NON-DESTRUCTIVE choice. That matters most for the
 * purge prompt: the harness runs against a real game directory that the
 * operator's own Vortex may have deployed mods into, and answering "Purge"
 * unattended would delete those. Anything not listed is deliberately left alone
 * and reported, rather than guessed at by clicking the first button.
 */
export const DEFAULT_DIALOG_POLICIES: DialogPolicy[] = [
  {
    match: /purge files from different instance/i,
    button: /^cancel$/i,
    because:
      "another Vortex instance deployed mods to this game; purging them unattended would " +
      "remove real files the operator did not ask to lose",
  },
  {
    match: /game not discovered|hasn't been automatically discovered/i,
    button: /^continue$/i,
    because: "the harness already registered the game's path explicitly",
  },
];

export interface AnsweredDialog {
  dialog: string;
  clicked: string;
  because: string;
}

/**
 * Watch for modals and answer the known ones until stopped.
 *
 * Runs alongside a long operation (activation, deployment) rather than being
 * called at a fixed point, because these dialogs appear at times the caller
 * cannot predict — mid-activation, after a deploy starts — and a blocked
 * operation otherwise just times out with no indication that something was
 * waiting for an answer.
 */
export function autoAnswerDialogs(
  mcp: VortexMcpClient,
  options: {
    policies?: DialogPolicy[];
    signal: AbortSignal;
    pollMs?: number;
    onAnswer?: (answered: AnsweredDialog) => void;
  },
): Promise<AnsweredDialog[]> {
  const policies = options.policies ?? DEFAULT_DIALOG_POLICIES;
  const pollMs = options.pollMs ?? 1_000;
  const answered: AnsweredDialog[] = [];

  return (async () => {
    while (!options.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (options.signal.aborted) break;

      const snap = await snapshot(mcp).catch(() => undefined);
      if (snap === undefined || snap.activeDialogs.length === 0) continue;

      for (const text of snap.activeDialogs) {
        const policy = policies.find((p) => p.match.test(text));
        if (policy === undefined) continue;

        const button = findNodes(snap, { role: "button", name: policy.button })[0];
        if (button === undefined) continue;

        await mcp.call("ui_click", { ref: button.ref }).catch(() => undefined);
        const record: AnsweredDialog = {
          dialog: text.slice(0, 160),
          clicked: button.name ?? String(policy.button),
          because: policy.because,
        };
        answered.push(record);
        options.onAnswer?.(record);
      }
    }
    return answered;
  })();
}
