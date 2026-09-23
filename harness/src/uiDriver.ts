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

export async function snapshot(
  mcp: VortexMcpClient,
  selector?: string,
  index?: number,
): Promise<Snapshot> {
  if (selector === undefined) return mcp.call<Snapshot>("ui_snapshot", {});
  return mcp.call<Snapshot>(
    "ui_snapshot",
    index === undefined ? { selector } : { selector, index },
  );
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
/**
 * The two possible answers to "Purge files from different instance?".
 *
 * Vortex raises this when the game directory holds files deployed by a
 * *different* Vortex instance, and it has to be answered before that game can
 * be deployed to at all. Which answer is right is not a property of the dialog,
 * it is a property of what the caller is doing — so both exist and the caller
 * chooses, rather than one being hardcoded.
 */
const FOREIGN_PURGE_REFUSED: DialogPolicy = {
  match: /purge files from different instance/i,
  button: /^cancel$/i,
  because:
    "another Vortex instance deployed mods to this game; purging them unattended would " +
    "remove real files the operator did not ask to lose",
};

const FOREIGN_PURGE_ACCEPTED: DialogPolicy = {
  match: /purge files from different instance/i,
  button: /^purge$/i,
  because: "the caller asked for the game to be reset to a clean state",
};

/**
 * The policy list, with the purge prompt answered according to intent.
 *
 * `allowForeignPurge` deletes files another Vortex instance deployed, so it is
 * opt-in per call and never inferred. Resetting a game to a known state is a
 * legitimate thing for a test harness to do — it is what makes a run
 * repeatable — but it is destructive to whatever else was using that game
 * directory, so nothing turns it on by accident.
 */
export function dialogPolicies(options: { allowForeignPurge?: boolean } = {}): DialogPolicy[] {
  return DEFAULT_DIALOG_POLICIES.map((policy) =>
    policy === FOREIGN_PURGE_REFUSED && options.allowForeignPurge === true
      ? FOREIGN_PURGE_ACCEPTED
      : policy,
  );
}

export const DEFAULT_DIALOG_POLICIES: DialogPolicy[] = [
  {
    // Must come first: clicking the wrong button here throws away an install
    // that is halfway done, and Vortex raises it whenever anything looks like a
    // cancellation — including a stray Escape.
    match: /cancel the installation/i,
    button: /^close$/i,
    because: "never abandon an install we started; Close dismisses without cancelling",
  },
  FOREIGN_PURGE_REFUSED,
  {
    match: /game version mismatch/i,
    button: /^continue$/i,
    because:
      "the collection targets a different game build; mods may misbehave, but stopping here " +
      "would make every collection untestable on an updated game",
  },
  {
    match: /game not discovered|hasn't been automatically discovered/i,
    button: /^continue$/i,
    because: "the harness already registered the game's path explicitly",
  },
  {
    // The rows are per-file dropdowns Vortex has already defaulted; the footer
    // button accepts those defaults.
    //
    // Matching it took three tries, and the reason is worth keeping: policies
    // match on ACCESSIBLE NAME, not textContent. This button reads "Confirm" in
    // the DOM and is named "Confirm changes", so a regex written from devtools
    // matches nothing while looking obviously right. /^(apply|continue|save
    // changes)$/ and then /^confirm$/ both failed that way, each time leaving a
    // purge behind an unanswered modal until it timed out.
    match: /external changes/i,
    button: /^confirm/i,
    because:
      "files changed outside Vortex; Confirm accepts the per-file defaults it has " +
      "already chosen, which during a purge means letting the removals stand",
  },
];

export interface AnsweredDialog {
  dialog: string;
  clicked: string;
  because: string;
}

/** Containers Vortex renders modals into, most specific first. */
const DIALOG_SELECTORS = ['[role="dialog"]', ".modal.in", ".modal.show", "dialog[open]"];

/**
 * Watch for modals and answer the known ones until stopped.
 *
 * Runs alongside a long operation (activation, a collection install) rather than
 * at a fixed point, because these dialogs appear at moments the caller cannot
 * predict — and a blocked operation otherwise just times out with no indication
 * that something was waiting for an answer.
 *
 * The button is looked up **inside the dialog**, never across the page. That is
 * not a tidiness point: Vortex's titlebar has a button called "Close", so a
 * page-wide search for a dialog's "Close" action finds the window control first
 * and shuts the application down mid-install. Which is exactly what happened.
 */
export function autoAnswerDialogs(
  mcp: VortexMcpClient,
  options: {
    policies?: DialogPolicy[];
    signal: AbortSignal;
    pollMs?: number;
    onAnswer?: (answered: AnsweredDialog) => void;
    /**
     * A policy matched the dialog but its button was not found.
     *
     * Worth surfacing loudly. The dialog stays open and blocks whatever raised
     * it, and from the outside that is indistinguishable from a hang — an
     * External Changes policy whose button regex matched none of the real
     * buttons silently stalled a purge here until it timed out.
     */
    onUnanswerable?: (dialog: string, wanted: string) => void;
  },
): Promise<AnsweredDialog[]> {
  const policies = options.policies ?? DEFAULT_DIALOG_POLICIES;
  const pollMs = options.pollMs ?? 1_000;
  const answered: AnsweredDialog[] = [];
  // Report each stuck dialog once, not on every poll.
  const warned = new Set<string>();

  return (async () => {
    while (!options.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (options.signal.aborted) break;

      const snap = await snapshot(mcp).catch(() => undefined);
      if (snap === undefined || snap.activeDialogs.length === 0) continue;

      for (const text of snap.activeDialogs) {
        const policy = policies.find((p) => p.match.test(text));
        if (policy === undefined) continue;

        const clicked = await clickInsideDialog(mcp, text, policy.button);
        if (clicked === undefined) {
          if (!warned.has(text)) {
            warned.add(text);
            options.onUnanswerable?.(text.slice(0, 160), String(policy.button));
          }
          continue;
        }

        const record: AnsweredDialog = {
          dialog: text.slice(0, 160),
          clicked,
          because: policy.because,
        };
        answered.push(record);
        options.onAnswer?.(record);
      }
    }
    return answered;
  })();
}

/**
 * Click a button within the dialog whose text matches, and only within it.
 *
 * Each modal container is snapshotted separately so refs are scoped to that
 * subtree; the right container is identified by its text matching the dialog we
 * decided to answer, which matters when two modals are stacked.
 */
async function clickInsideDialog(
  mcp: VortexMcpClient,
  dialogText: string,
  button: string | RegExp,
): Promise<string | undefined> {
  const marker = dialogText.slice(0, 20);

  for (const selector of DIALOG_SELECTORS) {
    // `index` picks the nth *match*, which is not what `:nth-of-type(n)` means.
    // That counts position among same-tag siblings, so with two modals mounted
    // under different parents every `div:nth-of-type(n)` matched both and
    // querySelector kept returning the first. The second of two stacked dialogs
    // was therefore unreachable: a purge prompt sat unanswered behind a
    // collection report and blocked an install, looking like a policy that
    // failed to match.
    for (let index = 0; index < 4; index++) {
      const snap = await snapshot(mcp, selector, index).catch(() => undefined);
      if (snap === undefined || snap.nodeCount === 0) break;

      // Only answer the dialog we actually matched on.
      const flat = flatten(snap.tree);
      const text = flat.map((n) => `${n.name ?? ""} ${n.text ?? ""}`).join(" ");
      if (!text.includes(marker)) continue;

      const target = findNodes(snap, { role: "button", name: button })[0];
      if (target === undefined) continue;

      await mcp.call("ui_click", { ref: target.ref }).catch(() => undefined);
      return target.name ?? String(button);
    }
  }
  return undefined;
}

/**
 * The FOMOD installer's own dialog, and the bar holding its step actions.
 *
 * Scoping to these is a safety property, not a tidiness one. A rule like "click
 * the dialog's last button" reads naturally and is badly wrong here: on the
 * "Purge files from different instance?" prompt the last button is *Purge*, and
 * the harness runs against a real Fallout 4 install with tens of thousands of
 * deployed files. Only the FOMOD nav bar is ever driven automatically.
 *
 * The bar holds Back (when there is a previous step), a progress bar, and the
 * forward action last. Cancel is not in it — it lives in the dialog header as
 * `#fomod-cancel` — so the forward action is simply the last enabled button.
 */
const FOMOD_DIALOG = "#fomod-installer-dialog";
const FOMOD_NAV = `${FOMOD_DIALOG} .fomod-nav-buttons`;

/**
 * Advance a FOMOD installer by one step, accepting whatever it has pre-selected.
 *
 * FOMOD steps do not have a predictably-named action button: Vortex labels it
 * after the step itself, so one collection produces "Next", "Install", "Finish"
 * and "Default Settings" across consecutive mods. Matching on labels handles
 * some and silently stalls on the rest, which is indistinguishable from a hung
 * install — it is what stalled this harness at 8 of 12 mods.
 *
 * So the match is positional: the last enabled button in the nav bar. Defaults
 * are taken as-is, which is what a collection wants, since the curator's choices
 * are already recorded in the collection manifest.
 *
 * Returns the label clicked, or undefined when no FOMOD dialog is open.
 */
export async function advanceFomod(mcp: VortexMcpClient): Promise<string | undefined> {
  const snap = await snapshot(mcp, FOMOD_NAV).catch(() => undefined);
  if (snap === undefined || snap.nodeCount === 0) return undefined;

  // Deliberately includes disabled buttons, because position is what identifies
  // the forward action. Filtering them out first would make a step with a
  // greyed-out Next fall through to Back and walk the wizard backwards forever.
  const buttons = findNodes(snap, { role: "button", enabledOnly: false });
  const forward = buttons[buttons.length - 1];
  if (forward === undefined || forward.disabled === true) return undefined;

  await mcp.call("ui_click", { ref: forward.ref });
  return forward.name ?? "(unnamed)";
}

/**
 * Click through FOMOD installers until stopped.
 *
 * Kept separate from autoAnswerDialogs because the two decide on opposite
 * principles: that one matches known prompts by text and deliberately picks the
 * conservative answer, while this one accepts defaults on anything the FOMOD
 * installer puts up. Enabling it is therefore an explicit choice, made where an
 * unattended install is already the intent.
 */
export function autoAdvanceFomods(
  mcp: VortexMcpClient,
  options: { signal: AbortSignal; pollMs?: number; onAdvance?: (label: string) => void },
): Promise<number> {
  const pollMs = options.pollMs ?? 1_500;
  let advanced = 0;

  return (async () => {
    while (!options.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (options.signal.aborted) break;

      const label = await advanceFomod(mcp).catch(() => undefined);
      if (label !== undefined) {
        advanced += 1;
        options.onAdvance?.(label);
      }
    }
    return advanced;
  })();
}
