/**
 * UI automation primitives for driving Vortex's renderer DOM directly.
 *
 * This extension already shares the renderer process with Vortex's React tree
 * (see index.ts's `context.once`), so everything here is plain DOM work against
 * the live UI — no CDP attach, no second Electron connection, no Playwright.
 * That is the whole point: an agent can drive a user's *real, already-running*
 * Vortex the same way it drives a test instance, and the read tools in
 * vortexControl.ts stay the ground truth for state while these stay the ground
 * truth for what is actually on screen.
 *
 * Two things deliberately do NOT live here:
 *
 * - **Screenshots.** They need `webContents.capturePage`, which lives in the
 *   main process; extensions are renderer-only in Vortex 2.x (`onceMain` is
 *   deprecated and logs "won't work as expected"). Rather than require a patch
 *   to Vortex itself, the harness takes them over CDP — which works against a
 *   stock, released Vortex. See harness/src/screenshot.ts.
 * - **Launching/building Vortex.** That is the harness's job; nothing here can
 *   start a process.
 *
 * Everything in this file works against an unmodified, officially released
 * Vortex. That constraint is deliberate and worth preserving.
 */

import { randomUUID } from "node:crypto";

// Vortex's own Electron preload bridge. Not part of @nexusmods/vortex-api and not
// a contract Nexus Mods commits to — same caveat as vortexControl.ts's use of
// window.api.app.relaunch. Only the members this module actually calls are declared.
interface VortexPreloadWindowApi {
  getId: () => Promise<number>;
  getSize: (windowId: number) => Promise<[number, number]>;
  setSize: (windowId: number, width: number, height: number) => Promise<void>;
  isMaximized: (windowId: number) => Promise<boolean>;
  unmaximize: (windowId: number) => Promise<void>;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function preloadWindowApi(): VortexPreloadWindowApi {
  const api = (globalThis as { api?: { window?: VortexPreloadWindowApi } }).api?.window;
  if (api === undefined) {
    throw new Error(
      "window.api.window is unavailable — this build of Vortex has an unexpected preload shape, " +
        "or this code is not running in the Vortex renderer process.",
    );
  }
  return api;
}

function doc(): Document {
  const d = (globalThis as { document?: Document }).document;
  if (d === undefined) {
    throw new Error("No DOM available — UI tools only work in the Vortex renderer process.");
  }
  return d;
}

function win(): Window {
  const w = (globalThis as { window?: Window }).window;
  if (w === undefined) {
    throw new Error("No window available — UI tools only work in the Vortex renderer process.");
  }
  return w;
}

// ---------------------------------------------------------------------------
// Ref registry
// ---------------------------------------------------------------------------

/**
 * Refs (`e12`) are handed out by `snapshot()` and consumed by the action tools.
 * They are scoped to a *generation*: every snapshot bumps the counter and clears
 * the table, so a ref from two snapshots ago fails loudly ("stale ref") instead
 * of silently resolving to whatever element now happens to hold that index.
 *
 * This matters more in Vortex than in a typical web app: most of its lists are
 * virtualised, so the element behind a given row index is genuinely recycled as
 * the user scrolls. A silently-reused ref would click the wrong mod.
 */
const refTable = new Map<string, Element>();
let refGeneration = 0;
let refCounter = 0;
const refSession = randomUUID().slice(0, 8);

function beginRefGeneration(): void {
  refGeneration += 1;
  // Never reuse a ref string. Resetting this counter lets an earlier snapshot's
  // e1 resolve to an unrelated element in the new generation.
  refTable.clear();
}

function assignRef(el: Element): string {
  refCounter += 1;
  const ref = `e${String(refCounter)}-${refSession}`;
  refTable.set(ref, el);
  return ref;
}

/** Resolve a `ref` from the most recent snapshot, or a CSS selector, to a live element. */
export function resolveTarget(target: { ref?: string; selector?: string }): Element {
  if (target.ref !== undefined) {
    if (refGeneration === 0) {
      throw new Error(`Unknown ref "${target.ref}" — call ui_snapshot first to allocate refs.`);
    }
    const el = refTable.get(target.ref);
    if (el === undefined) {
      throw new Error(
        `Stale or unknown ref "${target.ref}". Refs are only valid until the next ui_snapshot ` +
          `(current generation ${String(refGeneration)}); take a fresh snapshot and use the new ref.`,
      );
    }
    if (!el.isConnected) {
      throw new Error(
        `Ref "${target.ref}" points at an element that has since been removed from the DOM ` +
          `(Vortex re-rendered). Take a fresh ui_snapshot.`,
      );
    }
    return el;
  }
  if (target.selector !== undefined) {
    const el = doc().querySelector(target.selector);
    if (el === null) {
      throw new Error(`No element matches selector ${JSON.stringify(target.selector)}.`);
    }
    return el;
  }
  throw new Error("Provide either `ref` (from ui_snapshot) or `selector`.");
}

// ---------------------------------------------------------------------------
// Roles, names, visibility
// ---------------------------------------------------------------------------

// Implicit ARIA roles for the element types that actually appear in Vortex's UI.
// Deliberately partial: an unmapped element falls through to its lowercased tag
// name, which is more useful in a snapshot than omitting it entirely.
const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  article: "article",
  aside: "complementary",
  button: "button",
  dialog: "dialog",
  fieldset: "group",
  footer: "contentinfo",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  header: "banner",
  hr: "separator",
  img: "img",
  li: "listitem",
  main: "main",
  nav: "navigation",
  ol: "list",
  option: "option",
  output: "status",
  progress: "progressbar",
  section: "region",
  select: "combobox",
  table: "table",
  tbody: "rowgroup",
  td: "cell",
  textarea: "textbox",
  th: "columnheader",
  tr: "row",
  ul: "list",
};

const INPUT_TYPE_ROLES: Record<string, string> = {
  button: "button",
  checkbox: "checkbox",
  email: "textbox",
  image: "button",
  number: "spinbutton",
  password: "textbox",
  radio: "radio",
  range: "slider",
  reset: "button",
  search: "searchbox",
  submit: "button",
  tel: "textbox",
  text: "textbox",
  url: "textbox",
};

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit !== null && explicit.trim() !== "") {
    return explicit.trim().split(/\s+/)[0] ?? explicit.trim();
  }
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    return INPUT_TYPE_ROLES[type] ?? "textbox";
  }
  if (tag === "a") {
    // An <a> with no href is not a link as far as assistive tech is concerned.
    return el.hasAttribute("href") ? "link" : "generic";
  }
  return IMPLICIT_ROLES[tag] ?? tag;
}

function textOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A pragmatic subset of the accessible-name computation: the attributes that
 * actually distinguish one Vortex control from another. Full AccName spec
 * resolution isn't reachable from script anyway (no exposed platform a11y tree).
 */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel.trim() !== "") return ariaLabel.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy !== null && labelledBy.trim() !== "") {
    const names = labelledBy
      .split(/\s+/)
      .map((id) => doc().getElementById(id))
      .filter((n): n is HTMLElement => n !== null)
      .map((n) => textOf(n));
    const joined = names.join(" ").trim();
    if (joined !== "") return joined;
  }

  const id = el.getAttribute("id");
  if (id !== null && id !== "") {
    // CSS.escape keeps ids containing generated characters (React/emotion often
    // produce ':' and '-') from throwing an invalid-selector error here.
    const escaped = cssEscape(id);
    const label = doc().querySelector(`label[for="${escaped}"]`);
    if (label !== null) {
      const t = textOf(label);
      if (t !== "") return t;
    }
  }

  const wrappingLabel = el.closest("label");
  if (wrappingLabel !== null) {
    const t = textOf(wrappingLabel);
    if (t !== "") return t;
  }

  for (const attr of ["placeholder", "title", "alt", "aria-placeholder"]) {
    const v = el.getAttribute(attr);
    if (v !== null && v.trim() !== "") return v.trim();
  }

  // Buttons and links name themselves from their own text; containers must not,
  // or a snapshot of a page would give the outermost div the whole page's text.
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || tag === "option" || /^h[1-6]$/.test(tag)) {
    return truncate(textOf(el), 120);
  }

  return "";
}

function cssEscape(value: string): string {
  const escapeFn = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (typeof escapeFn === "function") return escapeFn(value);
  return value.replace(/["\\]/g, "\\$&");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Whether an element and everything inside it is hidden from the user.
 *
 * Only properties that genuinely hide a *subtree* count here, because the
 * snapshot walk prunes the children of anything this rejects. Two things that
 * look like they belong in this list deliberately do not:
 *
 * - **An empty `getClientRects()`**. An element with `display: contents`
 *   generates no box of its own while its children render normally — a common
 *   React/CSS wrapper. Treating it as hidden silently deletes whole visible
 *   sections of the UI from the snapshot. (Found the hard way: Vortex's entire
 *   game grid vanished, tiles and all, while plainly on screen.)
 * - **A falsy `opacity`**. `getComputedStyle().opacity` can come back as an
 *   empty string, and `Number("") === 0` — so a naive zero-check reads an
 *   unresolved value as fully transparent and hides everything beneath it.
 *   Only a value that actually parses to 0 counts.
 * - **`aria-hidden="true"`**. It means "hidden from assistive technology", not
 *   "not rendered", and the standard modal pattern sets it on the whole app
 *   root while a dialog is open — which is exactly what Vortex does, on
 *   `#content` and `#overlays`. Pruning on it blanked the entire snapshot
 *   whenever any dialog was up: precisely the state an agent most needs to see.
 *   It is reported per node as `ariaHidden` instead, so a caller can still tell.
 */
function isSubtreeHidden(el: Element): boolean {
  const style = win().getComputedStyle(el);
  if (style.display === "none") return true;
  if (style.visibility === "hidden" || style.visibility === "collapse") return true;

  const opacity = Number.parseFloat(style.opacity);
  return Number.isFinite(opacity) && opacity === 0;
}

export function isVisible(el: Element): boolean {
  return !isSubtreeHidden(el);
}

/**
 * Whether an element can actually receive a click.
 *
 * Stricter than isVisible: here a zero-size box IS disqualifying, because there
 * is no point on screen to dispatch the event at. This check belongs only on
 * the action path — using it for snapshot pruning is exactly what hides
 * `display: contents` wrappers along with all their visible children.
 */
function hasRenderedBox(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (typeof htmlEl.getClientRects !== "function") return true;
  if (htmlEl.getClientRects().length > 0) return true;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function isDisabled(el: Element): boolean {
  if (el.hasAttribute("disabled")) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  // Vortex's Bootstrap-derived controls mark disabled state with a class on a
  // wrapper rather than the `disabled` attribute in several places.
  return el.classList.contains("disabled");
}

/** Roles worth surfacing as their own snapshot node even without an accessible name. */
const INTERESTING_ROLES = new Set([
  "alert",
  "button",
  "checkbox",
  "columnheader",
  "combobox",
  "dialog",
  "heading",
  "link",
  "listitem",
  "menuitem",
  "option",
  "progressbar",
  "radio",
  "row",
  "searchbox",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "tabpanel",
  "textbox",
]);

const SKIPPED_TAGS = new Set(["script", "style", "noscript", "template", "svg", "head", "meta"]);

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface SnapshotOptions {
  /** CSS selector to snapshot within. Defaults to the whole document body. */
  selector?: string;
  /**
   * Which match of `selector` to use, when it matches more than one. Defaults to 0.
   *
   * CSS cannot express this. `:nth-of-type()` counts position among siblings of
   * the same tag, so with two modals mounted under different parents every
   * `div:nth-of-type(n)` matches both and `querySelector` keeps returning the
   * first — which made the second of two stacked dialogs unaddressable, and a
   * caller trying to answer it silently operate on the wrong one.
   */
  index?: number;
  /** Include elements that are present but not visible. Defaults to false. */
  includeHidden?: boolean;
  /** Maximum tree depth to walk. Defaults to 25. */
  maxDepth?: number;
  /** Maximum number of nodes to emit before truncating. Defaults to 1500. */
  maxNodes?: number;
  /** Include each node's bounding box. Off by default — it roughly doubles size. */
  includeBox?: boolean;
}

export interface SnapshotNode {
  ref: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  disabled?: boolean;
  /** Hidden from assistive tech but still rendered — e.g. behind an open modal. */
  ariaHidden?: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  focused?: boolean;
  box?: CaptureRect;
  children?: SnapshotNode[];
}

export interface SnapshotResult {
  generation: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  nodeCount: number;
  truncated: boolean;
  /** Text of any modal dialog currently on screen — the thing most likely to block an action. */
  activeDialogs: string[];
  /**
   * With a `selector`: the scoped root's text, built exactly as an `activeDialogs` entry is,
   * so a caller can tell which of several matched containers is the dialog it read. The
   * tree's names are no substitute: they include placeholders and labels that are not text.
   */
  rootText?: string;
  tree: SnapshotNode[];
}

/**
 * Build a compact accessibility-flavoured tree of the live UI, allocating a fresh
 * `ref` for every emitted node.
 *
 * Purely structural pruning keeps this usable as an agent's primary "what is on
 * screen" call: wrapper elements that carry no role, name, test id or direct text
 * are collapsed into their children rather than emitted, which is what stops a
 * React tree's dozens of layout divs per control from drowning the signal.
 */
/**
 * The `index`-th element matching `selector`, with a message that distinguishes
 * "nothing matches" from "fewer matches than you asked for" — the two have very
 * different causes and the same symptom.
 */
function matchAt(selector: string, index: number): Element {
  const all = doc().querySelectorAll(selector);
  const el = all[index];
  if (el === undefined) {
    throw new Error(
      all.length === 0
        ? `No element matches selector ${JSON.stringify(selector)}.`
        : `Selector ${JSON.stringify(selector)} matches ${String(all.length)} element(s), ` +
            `so index ${String(index)} is out of range.`,
    );
  }
  return el;
}

export function snapshot(options: SnapshotOptions = {}): SnapshotResult {
  const {
    selector,
    index = 0,
    includeHidden = false,
    maxDepth = 25,
    maxNodes = 1500,
    includeBox = false,
  } = options;

  beginRefGeneration();

  const document = doc();
  const root: Element =
    selector === undefined ? (document.body as Element) : matchAt(selector, index);

  let emitted = 0;
  let truncated = false;
  const active = document.activeElement;

  const walk = (el: Element, depth: number): SnapshotNode[] => {
    if (depth > maxDepth || SKIPPED_TAGS.has(el.tagName.toLowerCase())) return [];
    if (!includeHidden && !isVisible(el)) return [];
    if (emitted >= maxNodes) {
      truncated = true;
      return [];
    }

    const children: SnapshotNode[] = [];
    for (const child of Array.from(el.children)) {
      children.push(...walk(child, depth + 1));
    }

    const role = roleOf(el);
    const name = accessibleName(el);
    const testId = el.getAttribute("data-testid") ?? el.getAttribute("data-test-id") ?? undefined;
    const ownText = directText(el);
    const interesting =
      INTERESTING_ROLES.has(role) ||
      name !== "" ||
      testId !== undefined ||
      ownText !== "" ||
      isInteractive(el);

    // Collapse uninteresting wrappers into their children so the tree describes
    // controls rather than layout.
    if (!interesting) return children;

    emitted += 1;
    const node: SnapshotNode = { ref: assignRef(el), role };
    if (name !== "") node.name = name;
    if (ownText !== "" && ownText !== name) node.text = truncate(ownText, 200);

    const value = valueOf(el);
    if (value !== undefined) node.value = truncate(value, 200);
    if (testId !== undefined) node.testId = testId;
    if (isDisabled(el)) node.disabled = true;
    if (el.getAttribute("aria-hidden") === "true") node.ariaHidden = true;

    const checked = checkedState(el);
    if (checked !== undefined) node.checked = checked;

    const expanded = el.getAttribute("aria-expanded");
    if (expanded !== null) node.expanded = expanded === "true";

    const selected = el.getAttribute("aria-selected");
    if (selected !== null) node.selected = selected === "true";

    if (el === active) node.focused = true;
    if (includeBox) node.box = boxOf(el);
    if (children.length > 0) node.children = children;

    return [node];
  };

  const tree = walk(root, 0);

  return {
    generation: refGeneration,
    url: doc().location?.href ?? "",
    title: document.title,
    viewport: { width: win().innerWidth, height: win().innerHeight },
    nodeCount: emitted,
    truncated,
    activeDialogs: collectDialogText(),
    ...(selector === undefined ? {} : { rootText: dialogTextOf(root) }),
    tree,
  };
}

/** Text belonging to this element itself, not to its element children. */
function directText(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) out += node.nodeValue ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (["a", "button", "input", "select", "textarea"].includes(tag)) return true;
  if (el.hasAttribute("onclick")) return true;
  const tabIndex = el.getAttribute("tabindex");
  return tabIndex !== null && tabIndex !== "-1";
}

function valueOf(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return (el as HTMLInputElement).value;
  }
  const ariaValue = el.getAttribute("aria-valuenow");
  return ariaValue ?? undefined;
}

function checkedState(el: Element): boolean | undefined {
  const aria = el.getAttribute("aria-checked");
  if (aria !== null) return aria === "true";
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "checkbox" || type === "radio") return (el as HTMLInputElement).checked;
  }
  return undefined;
}

function boxOf(el: Element): CaptureRect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/**
 * Text of every modal currently on screen. Surfaced at the top level of a
 * snapshot because a modal is the single most common reason an otherwise-correct
 * click does nothing, and an agent reading a deep tree can easily miss it.
 */
/**
 * The text of every visible modal, without walking the rest of the UI. A full snapshot
 * measures every rendered element; polled every second while a large mod list is on screen,
 * that alone costs seconds of renderer time and skews what is being measured.
 */
export function activeDialogs(): string[] {
  return collectDialogText();
}

/** How a dialog's text is reported, in `activeDialogs` and a scoped snapshot's `rootText`. */
function dialogTextOf(el: Element): string {
  return truncate(textOf(el), 400);
}

function collectDialogText(): string[] {
  return activeDialogElements().map((d) => d.text);
}

/**
 * The visible modals with the element each `activeDialogs` entry was read from: the first
 * container found for each distinct text.
 */
export function activeDialogElements(): Array<{ text: string; element: Element }> {
  const out: Array<{ text: string; element: Element }> = [];
  const selectors = ['[role="dialog"]', ".modal.in", ".modal.show", "dialog[open]"];
  for (const sel of selectors) {
    for (const el of Array.from(doc().querySelectorAll(sel))) {
      if (!isVisible(el)) continue;
      const t = dialogTextOf(el);
      if (t !== "" && !out.some((d) => d.text === t)) out.push({ text: t, element: el });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ActionTarget {
  ref?: string;
  selector?: string;
}

export interface ClickOptions extends ActionTarget {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  /** Modifier keys held for the click. */
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  /** Throw if the element is not visible/enabled. Defaults to true. */
  requireActionable?: boolean;
}

const BUTTON_CODES = { left: 0, middle: 1, right: 2 } as const;

/**
 * Click via a real pointer/mouse event sequence rather than `el.click()`.
 *
 * Vortex's UI is React plus a lot of Bootstrap-derived widgets, and several of
 * them (dropdown toggles, the table row selection handler) listen on `mousedown`
 * rather than `click`. `HTMLElement.click()` dispatches only a `click` event, so
 * those widgets simply never respond to it.
 */
export function click(options: ClickOptions): { ref?: string; role: string; name: string } {
  const el = resolveTarget(options);
  const { requireActionable = true } = options;

  if (requireActionable) assertActionable(el, "click");

  scrollIntoView(el);

  const rect = el.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  const button = BUTTON_CODES[options.button ?? "left"];
  const modifiers = options.modifiers ?? [];

  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button,
    buttons: button === 0 ? 1 : button === 2 ? 2 : 4,
    altKey: modifiers.includes("Alt"),
    ctrlKey: modifiers.includes("Control"),
    metaKey: modifiers.includes("Meta"),
    shiftKey: modifiers.includes("Shift"),
  };

  const clickCount = options.clickCount ?? 1;
  dispatchMouse(el, "pointerover", init);
  dispatchMouse(el, "mouseover", init);
  dispatchMouse(el, "pointermove", init);
  dispatchMouse(el, "mousemove", init);

  for (let i = 1; i <= clickCount; i++) {
    dispatchMouse(el, "pointerdown", init);
    dispatchMouse(el, "mousedown", init);
    focusIfPossible(el);
    dispatchMouse(el, "pointerup", init);
    dispatchMouse(el, "mouseup", init);
    dispatchMouse(el, button === 2 ? "contextmenu" : "click", { ...init, detail: i });
  }
  if (clickCount === 2) dispatchMouse(el, "dblclick", { ...init, detail: 2 });

  return { ref: options.ref, role: roleOf(el), name: accessibleName(el) };
}

function dispatchMouse(el: Element, type: string, init: MouseEventInit): void {
  const w = win() as unknown as {
    PointerEvent?: typeof MouseEvent;
    MouseEvent: typeof MouseEvent;
  };
  // PointerEvent isn't available in every test DOM; MouseEvent carries the same
  // fields the listeners here actually read.
  const Ctor = type.startsWith("pointer") ? (w.PointerEvent ?? w.MouseEvent) : w.MouseEvent;
  el.dispatchEvent(new Ctor(type, init));
}

function focusIfPossible(el: Element): void {
  const focusable = el as HTMLElement;
  if (typeof focusable.focus === "function") {
    focusable.focus({ preventScroll: true });
  }
}

function scrollIntoView(el: Element): void {
  const target = el as HTMLElement;
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "center", inline: "center" });
  }
}

function assertActionable(el: Element, action: string): void {
  if (!isVisible(el) || !hasRenderedBox(el)) {
    throw new Error(
      `Cannot ${action}: element <${el.tagName.toLowerCase()}> is not visible. ` +
        `It may be behind a modal, on an inactive tab, or scrolled out of a virtualised list.`,
    );
  }
  if (isDisabled(el)) {
    throw new Error(
      `Cannot ${action}: element <${el.tagName.toLowerCase()}> is disabled ` +
        `(name: ${JSON.stringify(accessibleName(el))}).`,
    );
  }
}

/**
 * Set the value of an input/textarea/contenteditable so React notices.
 *
 * React installs its own value setter on the DOM node and tracks the last value
 * it wrote; assigning `el.value` directly updates the DOM but leaves React's
 * tracker in sync with the *old* value, so the synthetic `input` event is
 * swallowed and `onChange` never fires. Calling the prototype's native setter
 * first is the standard way round it.
 */
export function fill(options: ActionTarget & { value: string }): { role: string; value: string } {
  const el = resolveTarget(options);
  assertActionable(el, "fill");
  scrollIntoView(el);
  focusIfPossible(el);

  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const input = el as HTMLInputElement;
    const proto =
      tag === "input"
        ? (win() as unknown as { HTMLInputElement: { prototype: object } }).HTMLInputElement
            .prototype
        : (win() as unknown as { HTMLTextAreaElement: { prototype: object } }).HTMLTextAreaElement
            .prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter !== undefined) {
      setter.call(input, options.value);
    } else {
      input.value = options.value;
    }
    input.dispatchEvent(
      new (win() as unknown as { Event: typeof Event }).Event("input", {
        bubbles: true,
      }),
    );
    input.dispatchEvent(
      new (win() as unknown as { Event: typeof Event }).Event("change", {
        bubbles: true,
      }),
    );
    return { role: roleOf(el), value: input.value };
  }

  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).textContent = options.value;
    el.dispatchEvent(
      new (win() as unknown as { Event: typeof Event }).Event("input", {
        bubbles: true,
      }),
    );
    return { role: roleOf(el), value: options.value };
  }

  throw new Error(
    `Cannot fill <${tag}> — not an input, textarea or contenteditable. ` +
      `Use ui_select_option for a <select>, or ui_click for a button.`,
  );
}

export interface PressKeyOptions extends ActionTarget {
  key: string;
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
}

/** Dispatch a keydown/keypress/keyup triple, on the target or the focused element. */
export function pressKey(options: PressKeyOptions): { key: string; target: string } {
  const el =
    options.ref !== undefined || options.selector !== undefined
      ? resolveTarget(options)
      : (doc().activeElement ?? doc().body);

  const modifiers = options.modifiers ?? [];
  const init: KeyboardEventInit = {
    key: options.key,
    code: options.key.length === 1 ? `Key${options.key.toUpperCase()}` : options.key,
    bubbles: true,
    cancelable: true,
    composed: true,
    altKey: modifiers.includes("Alt"),
    ctrlKey: modifiers.includes("Control"),
    metaKey: modifiers.includes("Meta"),
    shiftKey: modifiers.includes("Shift"),
  };

  const KeyboardEventCtor = (win() as unknown as { KeyboardEvent: typeof KeyboardEvent })
    .KeyboardEvent;
  el.dispatchEvent(new KeyboardEventCtor("keydown", init));
  if (options.key.length === 1) el.dispatchEvent(new KeyboardEventCtor("keypress", init));
  el.dispatchEvent(new KeyboardEventCtor("keyup", init));

  return { key: options.key, target: `${el.tagName.toLowerCase()}${describeBriefly(el)}` };
}

function describeBriefly(el: Element): string {
  const name = accessibleName(el);
  return name === "" ? "" : ` (${name})`;
}

export function hover(options: ActionTarget): { role: string; name: string } {
  const el = resolveTarget(options);
  scrollIntoView(el);
  const rect = el.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2),
  };
  dispatchMouse(el, "pointerover", init);
  dispatchMouse(el, "mouseover", init);
  dispatchMouse(el, "pointermove", init);
  dispatchMouse(el, "mousemove", init);
  dispatchMouse(el, "mouseenter", init);
  return { role: roleOf(el), name: accessibleName(el) };
}

/** Select an option in a native <select> by value or visible label. */
export function selectOption(options: ActionTarget & { value?: string; label?: string }): {
  value: string;
  label: string;
} {
  const el = resolveTarget(options);
  if (el.tagName.toLowerCase() !== "select") {
    throw new Error(`ui_select_option needs a <select>, got <${el.tagName.toLowerCase()}>.`);
  }
  assertActionable(el, "select");
  const select = el as HTMLSelectElement;

  const match = Array.from(select.options).find((opt) =>
    options.value !== undefined ? opt.value === options.value : textOf(opt) === options.label,
  );
  if (match === undefined) {
    const available = Array.from(select.options)
      .map((o) => `${JSON.stringify(o.value)} (${textOf(o)})`)
      .join(", ");
    throw new Error(
      `No option matching ${JSON.stringify(options.value ?? options.label)}. Available: ${available}`,
    );
  }

  select.value = match.value;
  const EventCtor = (win() as unknown as { Event: typeof Event }).Event;
  select.dispatchEvent(new EventCtor("input", { bubbles: true }));
  select.dispatchEvent(new EventCtor("change", { bubbles: true }));
  return { value: match.value, label: textOf(match) };
}

export function scroll(options: ActionTarget & { deltaX?: number; deltaY?: number }): {
  scrollTop: number;
  scrollLeft: number;
} {
  const dx = options.deltaX ?? 0;
  const dy = options.deltaY ?? 0;

  if (options.ref === undefined && options.selector === undefined) {
    win().scrollBy(dx, dy);
    return { scrollTop: win().scrollY, scrollLeft: win().scrollX };
  }
  const el = resolveTarget(options) as HTMLElement;
  el.scrollTop += dy;
  el.scrollLeft += dx;
  // Virtualised lists (Vortex's mod table) render on scroll events, not on a
  // scrollTop assignment — dispatch one so the new rows actually mount.
  el.dispatchEvent(
    new (win() as unknown as { Event: typeof Event }).Event("scroll", {
      bubbles: true,
    }),
  );
  return { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export interface WaitForOptions {
  selector?: string;
  /** Substring match against the document's visible text. */
  text?: string;
  state?: "visible" | "hidden" | "attached" | "detached";
  timeoutMs?: number;
  pollMs?: number;
}

export interface WaitForResult {
  matched: boolean;
  waitedMs: number;
  state: string;
}

/**
 * Poll until a selector or text reaches the requested state.
 *
 * Polling rather than MutationObserver on purpose: the `text` mode has to
 * re-read rendered text anyway, and Vortex's virtualised tables mutate
 * constantly during a deploy, which makes an observer fire far more often than
 * it usefully resolves.
 */
export async function waitFor(options: WaitForOptions): Promise<WaitForResult> {
  const { selector, text, state = "visible", timeoutMs = 10_000, pollMs = 100 } = options;
  if (selector === undefined && text === undefined) {
    throw new Error("ui_wait_for needs either `selector` or `text`.");
  }

  const started = Date.now();
  const satisfied = (): boolean => {
    if (text !== undefined) {
      const body = doc().body;
      const found = (
        body.innerText !== undefined ? body.innerText : (body.textContent ?? "")
      ).includes(text);
      return state === "hidden" || state === "detached" ? !found : found;
    }
    const el = doc().querySelector(selector as string);
    switch (state) {
      case "attached":
        return el !== null;
      case "detached":
        return el === null;
      case "hidden":
        return el === null || !isVisible(el);
      default:
        return el !== null && isVisible(el);
    }
  };

  for (;;) {
    if (satisfied()) {
      return { matched: true, waitedMs: Date.now() - started, state };
    }
    if (Date.now() - started >= timeoutMs) {
      return { matched: false, waitedMs: Date.now() - started, state };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// ---------------------------------------------------------------------------
// Viewport / responsiveness
// ---------------------------------------------------------------------------

export interface Viewport {
  width: number;
  height: number;
}

export async function getViewport(): Promise<{
  window: Viewport;
  inner: Viewport;
  devicePixelRatio: number;
}> {
  const api = preloadWindowApi();
  const [width, height] = await api.getSize(await api.getId());
  return {
    window: { width, height },
    inner: { width: win().innerWidth, height: win().innerHeight },
    devicePixelRatio: win().devicePixelRatio,
  };
}

/**
 * Resize the real Electron BrowserWindow.
 *
 * Unmaximises first: `setSize` on a maximised window is silently ignored on
 * Windows, which otherwise makes every viewport in a responsive sweep report the
 * same (maximised) size and produce identical, meaningless results.
 */
export async function setViewport(
  viewport: Viewport,
): Promise<{ requested: Viewport; actual: Viewport }> {
  const api = preloadWindowApi();
  const windowId = await api.getId();

  if (await api.isMaximized(windowId)) {
    await api.unmaximize(windowId);
  }
  await api.setSize(windowId, Math.round(viewport.width), Math.round(viewport.height));

  // Let the resize land and React re-render before reporting back; without this
  // the immediately-following read still reports the pre-resize size.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const [actualWidth, actualHeight] = await api.getSize(windowId);
  return { requested: viewport, actual: { width: actualWidth, height: actualHeight } };
}

export interface LayoutIssue {
  kind: "horizontal-overflow" | "clipped-text" | "offscreen" | "tiny-target" | "overlap";
  selector: string;
  role: string;
  name: string;
  detail: string;
  box: CaptureRect;
}

/** Minimum comfortable interactive target edge, in CSS px (WCAG 2.2 target-size minimum). */
const MIN_TARGET_PX = 24;

/**
 * Heuristics for the layout breakages a width/height change actually causes.
 *
 * Deliberately heuristic and reported, never auto-failed: a horizontal scrollbar
 * inside a deliberately-scrollable pane is normal, so the caller decides what
 * counts as a regression. Each issue carries a selector so it can be re-examined
 * with ui_snapshot.
 */
export function detectLayoutIssues(options: { maxIssues?: number } = {}): {
  viewport: Viewport;
  documentScrollWidth: number;
  hasHorizontalOverflow: boolean;
  issues: LayoutIssue[];
} {
  const maxIssues = options.maxIssues ?? 60;
  const document = doc();
  const viewportWidth = win().innerWidth;
  const viewportHeight = win().innerHeight;
  const issues: LayoutIssue[] = [];

  const push = (issue: LayoutIssue): void => {
    if (issues.length < maxIssues) issues.push(issue);
  };

  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (SKIPPED_TAGS.has(el.tagName.toLowerCase())) continue;
    if (!isVisible(el)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const box = boxOf(el);
    const role = roleOf(el);
    const name = accessibleName(el);
    const sel = describeSelector(el);

    // Something sticking out past the right edge of the viewport is the classic
    // narrow-window breakage.
    if (rect.right > viewportWidth + 1 && rect.left < viewportWidth) {
      push({
        kind: "horizontal-overflow",
        selector: sel,
        role,
        name,
        detail: `extends ${String(Math.round(rect.right - viewportWidth))}px past the right edge (viewport ${String(viewportWidth)}px)`,
        box,
      });
    }

    // Entirely outside the viewport horizontally — usually a flex child that
    // refused to shrink and pushed a sibling out.
    if (rect.left >= viewportWidth || rect.right <= 0) {
      push({
        kind: "offscreen",
        selector: sel,
        role,
        name,
        detail: `rendered fully outside the viewport horizontally (x ${String(box.x)}..${String(box.x + box.width)})`,
        box,
      });
    }

    // Text cut off with no way to scroll to it.
    const htmlEl = el as HTMLElement;
    const style = win().getComputedStyle(el);
    const clipsX = style.overflowX === "hidden" || style.overflow === "hidden";
    if (clipsX && htmlEl.scrollWidth > htmlEl.clientWidth + 1 && directText(el) !== "") {
      push({
        kind: "clipped-text",
        selector: sel,
        role,
        name,
        detail: `content is ${String(htmlEl.scrollWidth - htmlEl.clientWidth)}px wider than its clipped box and cannot be scrolled to`,
        box,
      });
    }

    // Interactive targets that shrank below a usable size.
    if (
      isInteractive(el) &&
      !isDisabled(el) &&
      rect.width > 0 &&
      rect.height > 0 &&
      (rect.width < MIN_TARGET_PX || rect.height < MIN_TARGET_PX)
    ) {
      push({
        kind: "tiny-target",
        selector: sel,
        role,
        name,
        detail: `interactive target is ${String(Math.round(rect.width))}x${String(Math.round(rect.height))}px, below the ${String(MIN_TARGET_PX)}px minimum`,
        box,
      });
    }
  }

  return {
    viewport: { width: viewportWidth, height: viewportHeight },
    documentScrollWidth: document.documentElement.scrollWidth,
    hasHorizontalOverflow: document.documentElement.scrollWidth > viewportWidth + 1,
    issues,
  };
}

/** A short, human-readable selector for an element — for reporting, not re-querying blindly. */
function describeSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const testId = el.getAttribute("data-testid");
  if (testId !== null) return `${tag}[data-testid="${testId}"]`;
  const id = el.getAttribute("id");
  if (id !== null && id !== "") return `${tag}#${id}`;
  const cls = el.getAttribute("class");
  if (cls !== null && cls.trim() !== "") {
    const first = cls.trim().split(/\s+/).slice(0, 2).join(".");
    return `${tag}.${first}`;
  }
  return tag;
}

export interface ResponsiveSweepResult {
  viewport: Viewport;
  actual: Viewport;
  inner: Viewport;
  hasHorizontalOverflow: boolean;
  issueCount: number;
  issues: LayoutIssue[];
}

/** The sizes worth checking by default: Vortex's own minimum, a common laptop, and a wide desktop. */
export const DEFAULT_SWEEP_VIEWPORTS: Viewport[] = [
  { width: 1024, height: 720 },
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

/**
 * Resize through a list of viewports, collecting layout diagnostics at each, then
 * restore the original size.
 *
 * The restore is in a `finally` so a mid-sweep failure doesn't leave the user's
 * real Vortex window stuck at 1024x720.
 */
export async function responsiveSweep(
  options: {
    viewports?: Viewport[];
    settleMs?: number;
    maxIssuesPerViewport?: number;
  } = {},
): Promise<{ restored: Viewport; results: ResponsiveSweepResult[] }> {
  const viewports = options.viewports ?? DEFAULT_SWEEP_VIEWPORTS;
  const settleMs = options.settleMs ?? 400;
  const original = (await getViewport()).window;
  const results: ResponsiveSweepResult[] = [];

  try {
    for (const viewport of viewports) {
      const { actual } = await setViewport(viewport);
      await new Promise((resolve) => setTimeout(resolve, settleMs));

      const layout = detectLayoutIssues({ maxIssues: options.maxIssuesPerViewport ?? 25 });
      const result: ResponsiveSweepResult = {
        viewport,
        actual,
        inner: { width: win().innerWidth, height: win().innerHeight },
        hasHorizontalOverflow: layout.hasHorizontalOverflow,
        issueCount: layout.issues.length,
        issues: layout.issues,
      };
      results.push(result);
    }
  } finally {
    await setViewport(original).catch(() => undefined);
  }

  return { restored: original, results };
}

// ---------------------------------------------------------------------------
// Renderer console capture
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
  seq: number;
  timestamp: string;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

const CONSOLE_BUFFER_MAX = 500;
const consoleBuffer: ConsoleEntry[] = [];
let consoleSeq = 0;
let consoleInstalled = false;

/**
 * Tee the renderer's console and uncaught errors into a ring buffer.
 *
 * Without this an agent has no way to see a React error or a failed fetch: the
 * renderer's DevTools console isn't reachable over MCP, and Vortex's own log file
 * only carries what Vortex explicitly logs, not what the browser runtime reports.
 * Wrapping (rather than replacing) keeps DevTools working normally for a human
 * looking at the same instance.
 */
export function installConsoleCapture(): void {
  if (consoleInstalled) return;
  consoleInstalled = true;

  const record = (level: ConsoleEntry["level"], args: unknown[]): void => {
    consoleSeq += 1;
    consoleBuffer.push({
      seq: consoleSeq,
      timestamp: new Date().toISOString(),
      level,
      text: args.map(stringifyArg).join(" ").slice(0, 2000),
    });
    if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
  };

  const target = globalThis.console;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[level].bind(target) as (...args: unknown[]) => void;
    target[level] = (...args: unknown[]): void => {
      record(level, args);
      original(...args);
    };
  }

  const w = globalThis as {
    addEventListener?: (type: string, listener: (ev: unknown) => void) => void;
  };
  w.addEventListener?.("error", (ev: unknown) => {
    const e = ev as { message?: string; filename?: string; lineno?: number };
    record("error", [
      `Uncaught: ${e.message ?? "unknown"} (${e.filename ?? "?"}:${String(e.lineno ?? 0)})`,
    ]);
  });
  w.addEventListener?.("unhandledrejection", (ev: unknown) => {
    const e = ev as { reason?: unknown };
    record("error", ["Unhandled rejection:", e.reason]);
  });
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Read the console ring buffer non-destructively; pass back `lastSeq` as `since`. */
export function readConsole(
  options: { since?: number; levels?: ConsoleEntry["level"][]; limit?: number } = {},
): { entries: ConsoleEntry[]; lastSeq: number; dropped: boolean } {
  const since = options.since ?? 0;
  const limit = options.limit ?? 200;
  let entries = consoleBuffer.filter((e) => e.seq > since);
  if (options.levels !== undefined && options.levels.length > 0) {
    entries = entries.filter((e) => options.levels?.includes(e.level) === true);
  }
  const dropped = consoleBuffer.length > 0 && since > 0 && consoleBuffer[0].seq > since + 1;
  return {
    entries: entries.slice(-limit),
    lastSeq: consoleSeq,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

/**
 * Reload the renderer, picking up a rebuilt bundle without restarting Electron.
 *
 * This is the hot-reload path: the harness rebuilds the renderer, then calls
 * this. Main-process state (and therefore the Redux store's persisted hives)
 * survives, so a reload is far cheaper than vortex_restart — but a change to
 * main-process code needs the full restart instead, because nothing here can
 * reload main.
 */
export function reloadRenderer(): void {
  const location = doc().location;
  if (location === null) throw new Error("No document.location to reload.");
  // Deferred so the MCP HTTP response can flush before the renderer tears down —
  // otherwise the caller sees a dropped connection rather than a success.
  setTimeout(() => location.reload(), 200);
}
