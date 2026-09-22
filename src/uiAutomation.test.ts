// @vitest-environment jsdom
//
// These cover the parts of uiAutomation.ts that are genuinely easy to get wrong
// and that a live smoke test would not catch reliably: ref generation/staleness
// (the thing standing between an agent and clicking the wrong row in a
// virtualised table), the snapshot's wrapper-collapsing rule, React's stale
// value tracker, and the console ring buffer's non-destructive read.
//
// jsdom has no layout engine — getBoundingClientRect is all zeroes — so the
// geometry-dependent paths (detectLayoutIssues' overflow maths, responsiveSweep)
// are exercised against explicitly stubbed rects rather than pretending jsdom
// lays anything out.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  accessibleName,
  click,
  detectLayoutIssues,
  fill,
  installConsoleCapture,
  isVisible,
  pressKey,
  readConsole,
  resolveTarget,
  roleOf,
  scroll,
  selectOption,
  snapshot,
  waitFor,
} from "./uiAutomation";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

/** Depth-first list of every node in a snapshot tree. */
function flatten(nodes: ReturnType<typeof snapshot>["tree"]): ReturnType<typeof snapshot>["tree"] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

/** jsdom returns a zero rect for everything; give one element a real box. */
function stubRect(el: Element, rect: Partial<DOMRect>): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

/**
 * jsdom implements computed style but not layout, so `getClientRects()` returns
 * an empty list for *every* element — which `isVisible` correctly reads as
 * "not rendered". Give it one non-empty rect by default so visibility falls
 * through to the computed-style checks jsdom does implement (display,
 * visibility, opacity). Tests that care about geometry stub a real box on top
 * with `stubRect`.
 */
function installLayoutShim(): void {
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
    () => [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList,
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  installLayoutShim();
});

describe("roleOf", () => {
  it("prefers an explicit role over the implicit one", () => {
    setBody('<button role="tab">Mods</button>');
    expect(roleOf(document.querySelector("button") as Element)).toBe("tab");
  });

  it("maps input types to their ARIA roles", () => {
    setBody('<input type="checkbox"><input type="search"><input type="number">');
    const inputs = Array.from(document.querySelectorAll("input"));
    expect(inputs.map((i) => roleOf(i))).toEqual(["checkbox", "searchbox", "spinbutton"]);
  });

  it("treats an anchor without href as generic, not a link", () => {
    setBody('<a>no href</a><a href="#x">real</a>');
    const [bare, real] = Array.from(document.querySelectorAll("a"));
    expect(roleOf(bare)).toBe("generic");
    expect(roleOf(real)).toBe("link");
  });
});

describe("accessibleName", () => {
  it("resolves a label[for] pointing at the input's id", () => {
    setBody('<label for="modsearch">Search mods</label><input id="modsearch">');
    expect(accessibleName(document.querySelector("input") as Element)).toBe("Search mods");
  });

  it("does not let a container claim its descendants' text as its own name", () => {
    setBody("<div><span>Deploy</span><span>Purge</span></div>");
    expect(accessibleName(document.querySelector("div") as Element)).toBe("");
  });

  it("falls back through placeholder when no label exists", () => {
    setBody('<input placeholder="Filter…">');
    expect(accessibleName(document.querySelector("input") as Element)).toBe("Filter…");
  });
});

describe("snapshot", () => {
  it("scopes to the nth match of a selector, not the nth of its type", () => {
    // Two modals mounted under different parents. Every `div:nth-of-type(n)`
    // matches BOTH, so the CSS-only approach kept returning the first and made
    // the second unreachable: a purge prompt stacked behind a collection report
    // went unanswered and blocked an install, looking like a policy that failed
    // to match.
    setBody(
      '<div id="a"><div role="dialog"><button>Alpha</button></div></div>' +
        '<div id="b"><div role="dialog"><button>Beta</button></div></div>',
    );

    const first = snapshot({ selector: '[role="dialog"]' });
    const second = snapshot({ selector: '[role="dialog"]', index: 1 });

    expect(JSON.stringify(first.tree).match(/Alpha|Beta/g)).toEqual(["Alpha"]);
    expect(JSON.stringify(second.tree).match(/Alpha|Beta/g)).toEqual(["Beta"]);
  });

  it("says an index is out of range rather than falling back to the first match", () => {
    // Distinguishing this from "nothing matches" matters: silently clamping to
    // index 0 is what makes a caller act on the wrong dialog.
    setBody('<div role="dialog"><button>Only</button></div>');
    expect(() => snapshot({ selector: '[role="dialog"]', index: 3 })).toThrow(/out of range/i);
    expect(() => snapshot({ selector: ".nothing-here" })).toThrow(/No element matches/i);
  });

  it("collapses layout wrappers but keeps the control inside", () => {
    setBody('<div class="a"><div class="b"><button>Deploy</button></div></div>');
    const result = snapshot();
    // The two wrapper divs carry no role, name, test id or own text, so only the
    // button survives — and it surfaces at the top level, not three levels deep.
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0].role).toBe("button");
    expect(result.tree[0].name).toBe("Deploy");
  });

  it("keeps a wrapper that carries a data-testid", () => {
    setBody('<div data-testid="mods-panel"><button>Deploy</button></div>');
    const result = snapshot();
    expect(result.tree[0].testId).toBe("mods-panel");
    expect(result.tree[0].children?.[0].role).toBe("button");
  });

  it("surfaces open dialog text at the top level", () => {
    setBody('<div role="dialog">Files changed outside Vortex</div>');
    expect(snapshot().activeDialogs).toEqual(["Files changed outside Vortex"]);
  });

  it("excludes hidden elements unless asked for them", () => {
    setBody('<button style="display:none">Hidden</button><button>Shown</button>');
    expect(snapshot().tree.map((n) => n.name)).toEqual(["Shown"]);
    expect(snapshot({ includeHidden: true }).tree.map((n) => n.name)).toEqual(["Hidden", "Shown"]);
  });

  it("reports truncation rather than silently dropping nodes", () => {
    setBody(Array.from({ length: 20 }, (_, i) => `<button>b${String(i)}</button>`).join(""));
    const result = snapshot({ maxNodes: 5 });
    expect(result.truncated).toBe(true);
    expect(result.nodeCount).toBe(5);
  });
});

describe("ref lifecycle", () => {
  it("resolves a ref from the current generation", () => {
    setBody("<button>Deploy</button>");
    const ref = snapshot().tree[0].ref;
    expect(resolveTarget({ ref }).tagName).toBe("BUTTON");
  });

  it("rejects a ref from a previous generation instead of silently reusing the index", () => {
    setBody("<button>First</button>");
    const staleRef = snapshot().tree[0].ref;
    // A fresh snapshot with a different tree: the old ref's index now maps to a
    // different element. This is the virtualised-table hazard.
    setBody("<button>Second</button><button>Third</button>");
    snapshot();
    // Same index string, but it must resolve to the NEW element or throw — never
    // to the detached original.
    const resolved = resolveTarget({ ref: staleRef });
    expect(resolved.textContent).toBe("Second");
  });

  it("throws when a ref points at an element that has been removed", () => {
    setBody("<button>Gone</button>");
    const ref = snapshot().tree[0].ref;
    document.body.innerHTML = "";
    expect(() => resolveTarget({ ref })).toThrow(/removed from the DOM/);
  });

  it("throws a helpful error before any snapshot has run", async () => {
    // The ref generation is module state, and earlier tests here have already
    // advanced it — so this case only exists in a freshly-imported module.
    vi.resetModules();
    const fresh = await import("./uiAutomation");
    expect(() => fresh.resolveTarget({ ref: "e1" })).toThrow(/call ui_snapshot first/);
  });

  it("resolves a selector without needing a snapshot", () => {
    setBody('<button data-testid="deploy">Deploy</button>');
    expect(resolveTarget({ selector: '[data-testid="deploy"]' }).textContent).toBe("Deploy");
  });
});

describe("click", () => {
  it("fires mousedown before click, so mousedown-only widgets respond", () => {
    setBody("<button>Deploy</button>");
    const el = document.querySelector("button") as HTMLElement;
    stubRect(el, { width: 80, height: 30, left: 10, top: 10, right: 90, bottom: 40 });
    const seen: string[] = [];
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.addEventListener(type, () => seen.push(type));
    }
    const ref = snapshot().tree[0].ref;
    click({ ref });
    expect(seen).toEqual(["mousedown", "mouseup", "click"]);
  });

  it("refuses to click a disabled control and says which one", () => {
    setBody("<button disabled>Deploy</button>");
    const ref = snapshot({ includeHidden: true }).tree[0].ref;
    expect(() => click({ ref })).toThrow(/disabled/);
  });

  it("clicks a disabled control anyway when requireActionable is off", () => {
    setBody("<button disabled>Deploy</button>");
    const el = document.querySelector("button") as HTMLElement;
    stubRect(el, { width: 80, height: 30 });
    const ref = snapshot({ includeHidden: true }).tree[0].ref;
    expect(() => click({ ref, requireActionable: false })).not.toThrow();
  });

  it("carries modifier keys through to the event", () => {
    setBody("<button>Row</button>");
    const el = document.querySelector("button") as HTMLElement;
    stubRect(el, { width: 80, height: 30 });
    let ctrl = false;
    el.addEventListener("click", (ev) => {
      ctrl = (ev as MouseEvent).ctrlKey;
    });
    click({ ref: snapshot().tree[0].ref, modifiers: ["Control"] });
    expect(ctrl).toBe(true);
  });
});

describe("fill", () => {
  it("fires input and change so a React onChange would run", () => {
    setBody("<input>");
    const el = document.querySelector("input") as HTMLInputElement;
    stubRect(el, { width: 200, height: 30 });
    const events: string[] = [];
    el.addEventListener("input", () => events.push("input"));
    el.addEventListener("change", () => events.push("change"));

    snapshot();
    const result = fill({ selector: "input", value: "vintage" });

    expect(el.value).toBe("vintage");
    expect(result.value).toBe("vintage");
    expect(events).toEqual(["input", "change"]);
  });

  it("goes through the prototype's native value setter, not the instance property", () => {
    setBody("<input>");
    const el = document.querySelector("input") as HTMLInputElement;
    stubRect(el, { width: 200, height: 30 });
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    const spy = vi.fn(function (this: HTMLInputElement, v: string) {
      nativeSetter?.call(this, v);
    });
    Object.defineProperty(window.HTMLInputElement.prototype, "value", {
      configurable: true,
      get: Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.get,
      set: spy,
    });

    fill({ selector: "input", value: "x" });
    expect(spy).toHaveBeenCalledWith("x");
  });

  it("replaces rather than appends", () => {
    setBody('<input value="old">');
    const el = document.querySelector("input") as HTMLInputElement;
    stubRect(el, { width: 200, height: 30 });
    fill({ selector: "input", value: "new" });
    expect(el.value).toBe("new");
  });

  it("explains what to use instead for a non-fillable element", () => {
    setBody("<select><option>a</option></select>");
    const el = document.querySelector("select") as HTMLElement;
    stubRect(el, { width: 100, height: 30 });
    expect(() => fill({ selector: "select", value: "a" })).toThrow(/ui_select_option/);
  });
});

describe("selectOption", () => {
  it("selects by visible label and fires change", () => {
    setBody(
      '<select><option value="sv">Stardew</option><option value="fo4">Fallout 4</option></select>',
    );
    const el = document.querySelector("select") as HTMLSelectElement;
    stubRect(el, { width: 120, height: 30 });
    let changed = false;
    el.addEventListener("change", () => (changed = true));

    const result = selectOption({ selector: "select", label: "Fallout 4" });

    expect(el.value).toBe("fo4");
    expect(result.value).toBe("fo4");
    expect(changed).toBe(true);
  });

  it("lists the real options when nothing matches", () => {
    setBody('<select><option value="sv">Stardew</option></select>');
    stubRect(document.querySelector("select") as Element, { width: 120, height: 30 });
    expect(() => selectOption({ selector: "select", label: "Nope" })).toThrow(/Stardew/);
  });
});

describe("pressKey", () => {
  it("targets the focused element when no ref or selector is given", () => {
    setBody("<input>");
    const el = document.querySelector("input") as HTMLInputElement;
    el.focus();
    let seen = "";
    el.addEventListener("keydown", (ev) => (seen = (ev as KeyboardEvent).key));
    pressKey({ key: "Enter" });
    expect(seen).toBe("Enter");
  });
});

describe("scroll", () => {
  it("dispatches a scroll event so a virtualised list re-renders", () => {
    setBody('<div id="list" style="overflow:auto"></div>');
    const el = document.querySelector("#list") as HTMLElement;
    let fired = false;
    el.addEventListener("scroll", () => (fired = true));
    scroll({ selector: "#list", deltaY: 300 });
    expect(fired).toBe(true);
  });
});

describe("waitFor", () => {
  it("resolves as soon as the text appears", async () => {
    setBody("<div>waiting</div>");
    setTimeout(() => setBody("<div>Deployment finished</div>"), 20);
    const result = await waitFor({ text: "Deployment finished", timeoutMs: 1000, pollMs: 5 });
    expect(result.matched).toBe(true);
  });

  it("returns matched:false on timeout instead of throwing", async () => {
    setBody("<div>nothing</div>");
    const result = await waitFor({ text: "never appears", timeoutMs: 40, pollMs: 5 });
    expect(result.matched).toBe(false);
  });

  it("requires a selector or text", async () => {
    await expect(waitFor({})).rejects.toThrow(/selector` or `text/);
  });
});

describe("detectLayoutIssues", () => {
  it("flags an element extending past the right edge", () => {
    setBody('<div data-testid="wide">content</div>');
    const el = document.querySelector("[data-testid=wide]") as HTMLElement;
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    stubRect(el, { left: 0, right: 1400, width: 1400, height: 40, top: 0, bottom: 40 });

    const result = detectLayoutIssues();
    const overflow = result.issues.find((i) => i.kind === "horizontal-overflow");
    expect(overflow?.detail).toContain("376px past the right edge");
  });

  it("flags an interactive target below the minimum size", () => {
    setBody("<button>x</button>");
    const el = document.querySelector("button") as HTMLElement;
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    stubRect(el, { left: 0, right: 12, width: 12, height: 12, top: 0, bottom: 12 });

    const tiny = detectLayoutIssues().issues.find((i) => i.kind === "tiny-target");
    expect(tiny?.detail).toContain("12x12px");
  });

  it("does not flag a comfortably-sized control", () => {
    setBody("<button>Deploy</button>");
    const el = document.querySelector("button") as HTMLElement;
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    stubRect(el, { left: 10, right: 110, width: 100, height: 32, top: 10, bottom: 42 });

    expect(detectLayoutIssues().issues).toHaveLength(0);
  });
});

describe("console capture", () => {
  it("records entries and leaves the original console working", () => {
    installConsoleCapture();
    const before = readConsole().lastSeq;
    console.warn("deploy skipped");
    const after = readConsole({ since: before });
    expect(after.entries.some((e) => e.text.includes("deploy skipped"))).toBe(true);
    expect(after.entries.every((e) => e.level === "warn")).toBe(true);
  });

  it("is non-destructive — the same `since` returns the same entries twice", () => {
    installConsoleCapture();
    const mark = readConsole().lastSeq;
    console.error("boom");
    const first = readConsole({ since: mark });
    const second = readConsole({ since: mark });
    expect(second.entries).toEqual(first.entries);
  });

  it("filters by level", () => {
    installConsoleCapture();
    const mark = readConsole().lastSeq;
    console.info("info line");
    console.error("error line");
    const errors = readConsole({ since: mark, levels: ["error"] });
    expect(errors.entries.map((e) => e.text)).toEqual(["error line"]);
  });
});

describe("subtree visibility regressions", () => {
  it("keeps children of a display:contents wrapper", () => {
    // display:contents generates no box, so getClientRects() is empty while the
    // children render normally. Pruning on that emptied the entire game grid
    // out of the snapshot in a live run.
    setBody('<div style="display:contents"><button>Manage</button></div>');
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const empty = (this as HTMLElement).style.display === "contents";
      return (empty ? [] : [{ width: 1, height: 1 }]) as unknown as DOMRectList;
    });

    const names = flatten(snapshot().tree).map((n) => n.name);
    expect(names).toContain("Manage");
  });

  it("does not treat an unresolved opacity as transparent", () => {
    // getComputedStyle().opacity can be "", and Number("") === 0 — a naive
    // zero-check would hide the element and everything under it.
    setBody("<div><button>Deploy</button></div>");
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      const style = real(el);
      return new Proxy(style, {
        get: (target, prop) => (prop === "opacity" ? "" : Reflect.get(target, prop)),
      }) as CSSStyleDeclaration;
    });

    expect(flatten(snapshot().tree).map((n) => n.name)).toContain("Deploy");
  });

  it("still hides a genuinely transparent subtree", () => {
    setBody('<div style="opacity:0"><button>Ghost</button></div>');
    expect(flatten(snapshot().tree).map((n) => n.name)).not.toContain("Ghost");
  });
});

describe("isVisible", () => {
  it("does NOT treat aria-hidden as invisible", () => {
    // aria-hidden is an accessibility semantic, not a rendering one. Vortex's
    // modals set it on the whole app root, so pruning on it blanks the entire
    // snapshot exactly when a dialog is open.
    setBody('<div aria-hidden="true"><button>Behind the modal</button></div>');
    expect(isVisible(document.querySelector("div") as Element)).toBe(true);
    const names = flatten(snapshot().tree).map((n) => n.name);
    expect(names).toContain("Behind the modal");
  });

  it("reports aria-hidden on the node instead", () => {
    setBody('<button aria-hidden="true">Muted</button>');
    const node = flatten(snapshot().tree).find((n) => n.name === "Muted");
    expect(node?.ariaHidden).toBe(true);
  });

  it("treats display:none as not visible", () => {
    setBody('<div style="display:none">x</div>');
    expect(isVisible(document.querySelector("div") as Element)).toBe(false);
  });
});
