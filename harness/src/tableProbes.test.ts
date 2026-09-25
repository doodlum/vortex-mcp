// @vitest-environment jsdom
//
// jsdom has no layout, so every box is stubbed explicitly; what is tested is the page code's
// own logic: which rows count as on screen, which ancestor counts as the scroller, and the
// verdicts drawn from the numbers.
import { afterEach, describe, expect, it } from "vitest";

import type { Page } from "@playwright/test";

import {
  CONFLICT_EDITOR_COUNTS,
  ROW_IDENTITY_RESTORE,
  columnWidthsSource,
  dropdownVerdict,
  measureAfter,
  recordDialogFade,
  rowIdentityInstallSource,
  rowsOnScreenSource,
  scrollToSource,
  shrinkingSamples,
  summariseAfter,
  summariseFrames,
  summariseRowIdentity,
  type RowIdentityRaw,
} from "./tableProbes";

// The probes are page source text; this runs it the way page.evaluate does, in the page's global.
// oxlint-disable-next-line no-eval
const run = (source: string): unknown => (0, eval)(source);

function box(element: Element, top: number, height: number, width = 100): void {
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: width, width, x: 0, y: top }) as DOMRect;
}

/** #table-mods whose page (not its own pane) scrolls: the 2.7 sticky-header layout. */
function table(rows: Array<{ top: number; cells: number }>): { scroller: HTMLElement } {
  document.body.innerHTML = `
    <div id="page" style="overflow-y: auto">
      <div id="table-mods">
        <div class="table-main-pane" style="overflow: visible">
          <div class="xthead"></div>
          <table><tbody></tbody></table>
        </div>
      </div>
    </div>`;
  const scroller = document.getElementById("page") as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { value: 5_000 });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  box(scroller, 0, 500);
  box(document.querySelector(".xthead") as Element, 0, 40);
  const tbody = document.querySelector("tbody") as HTMLElement;
  for (const [i, row] of rows.entries()) {
    const tr = document.createElement("tr");
    tr.setAttribute("data-rowid", `mod-${String(i)}`);
    for (let c = 0; c < row.cells; c++) tr.appendChild(document.createElement("td"));
    box(tr, row.top, 30);
    tbody.appendChild(tr);
  }
  return { scroller };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("rows on screen", () => {
  it("counts rows between the header and the scroller's bottom, placeholders apart", () => {
    table([
      { top: 10, cells: 5 }, // under the sticky header
      { top: 60, cells: 5 },
      { top: 200, cells: 1 }, // a blank placeholder on screen
      { top: 900, cells: 5 }, // rendered, scrolled out of view
      { top: 1_200, cells: 1 },
    ]);
    expect(run(rowsOnScreenSource("mods"))).toEqual({
      placeholders: 1,
      rendered: 1,
      renderedTotal: 3,
      total: 5,
    });
  });

  it("scrolls the ancestor that actually scrolls, with a scroll event", () => {
    const { scroller } = table([]);
    let events = 0;
    scroller.addEventListener("scroll", () => events++);
    expect(run(scrollToSource("mods", 0.5))).toBe(true);
    expect(scroller.scrollTop).toBe(2_250);
    expect(events).toBe(1);
    document.body.innerHTML = "";
    expect(run(scrollToSource("mods", 0.5))).toBe(false);
  });

  it("reads header widths by id or header- class", () => {
    document.body.innerHTML = `<div id="table-mods"><div class="xthead">
      <div class="table-header-cell header-enabled"></div><div class="table-header-cell" id="name"></div></div></div>`;
    const cells = document.querySelectorAll(".table-header-cell");
    box(cells[0] as Element, 0, 30, 138.4);
    box(cells[1] as Element, 0, 30, 600);
    expect(run(columnWidthsSource("mods"))).toEqual([
      { id: "header-enabled", width: 138 },
      { id: "name", width: 600 },
    ]);
  });

  it("counts the conflict editor's rendered entries and placeholders", () => {
    expect(run(CONFLICT_EDITOR_COUNTS)).toBeNull();
    document.body.innerHTML = `<div id="conflict-editor-dialog"><div class="modal-body">
      <div id="content-a"></div><div id="placeholder-b"></div><div id="placeholder-c"></div></div></div>`;
    expect(run(CONFLICT_EDITOR_COUNTS)).toMatchObject({ content: 1, placeholders: 2 });
  });
});

describe("verdicts", () => {
  it("summarises frame gaps and long tasks", () => {
    expect(summariseFrames([16, 17, 133, 16], [60, 120])).toEqual({
      longTasks: 2,
      longestMs: 120,
      blockedMs: 180,
      maxFrameGapMs: 133,
      p95FrameMs: 133,
      frames: 4,
    });
    expect(summariseFrames([], [])).toMatchObject({ maxFrameGapMs: 0, longestMs: 0 });
  });

  it("tells which way a dropdown opened and how much the scroll area clips", () => {
    const area = { areaTop: 100, areaBottom: 700 };
    expect(
      dropdownVerdict({ rowTop: 650, rowBottom: 680, menuTop: 480, menuBottom: 648, ...area }),
    ).toEqual({ direction: "up", clippedPx: 0 });
    expect(
      dropdownVerdict({ rowTop: 110, rowBottom: 140, menuTop: 142, menuBottom: 310, ...area }),
    ).toEqual({ direction: "down", clippedPx: 0 });
    // Opening down from the bottom row: 43 px under the scroll area's edge.
    expect(
      dropdownVerdict({ rowTop: 640, rowBottom: 670, menuTop: 575, menuBottom: 743, ...area }),
    ).toEqual({ direction: "down", clippedPx: 43 });
  });

  it("flags a noShrink column only when it narrows after growing", () => {
    expect(
      shrinkingSamples([
        { label: "top", width: 138 },
        { label: "band", width: 142 },
        { label: "top again", width: 142 },
      ]),
    ).toEqual([]);
    expect(
      shrinkingSamples([
        { label: "top", width: 138 },
        { label: "band", width: 142 },
        { label: "top again", width: 138 },
      ]),
    ).toEqual([{ label: "top again", width: 138 }]);
  });
});

/** Enough of a Playwright page to run the probes' node side against this jsdom. */
const fakePage = {
  evaluate: async (source: string) => run(source),
  waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
} as unknown as Page;

const later = (ms: number, fn: () => void): void => {
  setTimeout(fn, ms);
};

describe("row identity", () => {
  class FakeRow {
    constructor(public props: Record<string, unknown>) {}
    shouldComponentUpdate(next: Record<string, unknown>): boolean {
      return this.props.data !== next.data;
    }
    render(): null {
      return null;
    }
  }

  it("counts rows given a new object, spurious ones, and rows that re-rendered, then restores", () => {
    document.body.innerHTML = `<div id="table-mods"></div><table><tbody><tr data-rowid="a"></tr></tbody></table>`;
    const superTable = {
      state: {
        calculatedValues: {
          a: { name: "A", enabled: true },
          b: { name: "B" },
          c: { name: "C" },
        } as Record<string, unknown>,
      },
      props: { tableId: "mods" },
      updateState(ns: { calculatedValues: Record<string, unknown> }) {
        this.state = { ...this.state, ...ns };
      },
    };
    const originalUpdate = superTable.updateState;
    const originalRender = FakeRow.prototype.render;
    const row = new FakeRow({ rawData: {}, tableId: "mods", data: { x: 1 } });
    Object.assign(document.getElementById("table-mods") as object, {
      __reactFiber$test: { stateNode: null, return: { stateNode: superTable, return: null } },
    });
    Object.assign(document.querySelector("tr") as object, {
      __reactFiber$test: { stateNode: row, return: null },
    });

    expect(run(rowIdentityInstallSource())).toEqual({ tables: ["mods"], rowPrototype: true });
    superTable.updateState({
      calculatedValues: {
        a: { name: "A", enabled: false }, // changed
        b: { name: "B" }, // a new object with the same values
        d: { name: "D" }, // added; c removed
      },
    });
    expect(superTable.state.calculatedValues).toHaveProperty("d");
    expect(row.shouldComponentUpdate({ ...row.props, data: { x: 1 } })).toBe(true);
    expect(row.shouldComponentUpdate({ ...row.props })).toBe(false);
    row.render();

    const raw = (window as unknown as { __vxRowId: RowIdentityRaw }).__vxRowId;
    expect(raw.commits[0]).toMatchObject({
      table: "mods",
      rows: 3,
      changedRefs: 2,
      spurious: 1,
      added: 1,
      removed: 1,
      spuriousSample: ["b"],
      keyHist: { enabled: 1 },
    });
    expect(summariseRowIdentity(raw).mods).toMatchObject({
      commits: 1,
      changedRefs: 2,
      spurious: 1,
      rowUpdates: 2,
      rowDataChanged: 1,
      rowDataChangedNoValueDiff: 1,
      rowRenders: 1,
    });

    expect(run(ROW_IDENTITY_RESTORE)).toBe(2);
    expect(superTable.updateState).toBe(originalUpdate);
    expect(FakeRow.prototype.render).toBe(originalRender);
    expect((window as unknown as { __vxRowId?: unknown }).__vxRowId).toBeUndefined();
  });

  it("reports nothing found on a page without tables", () => {
    document.body.innerHTML = "<div></div>";
    expect(run(rowIdentityInstallSource(["plugins"]))).toEqual({
      tables: [],
      rowPrototype: false,
    });
  });
});

describe("measuring until the page shows the result", () => {
  it("splits long tasks at the moment the condition held", () => {
    expect(
      summariseAfter({
        start: 1_000,
        metAt: 1_500,
        tasks: [
          [1_100, 120],
          [1_450, 300],
          [1_700, 80],
        ],
        checks: 9,
        end: 2_000,
      }),
    ).toEqual({
      conditionMet: true,
      conditionMs: 500,
      untilCondition: { longTasks: 2, blockedMs: 420, longestMs: 300 },
      total: { longTasks: 3, blockedMs: 500, longestMs: 300, windowMs: 1_000 },
    });
    expect(summariseAfter({ start: 0, metAt: null, tasks: [], checks: 1, end: 50 })).toMatchObject({
      conditionMet: false,
      conditionMs: null,
    });
  });

  it("waits for the DOM to show the change, and refuses a condition that already holds", async () => {
    document.body.innerHTML = `<div id="list"></div>`;
    const condition = `document.querySelector("#done") !== null`;
    const measured = await measureAfter(
      fakePage,
      async () => {
        later(40, () => {
          const done = document.createElement("span");
          done.id = "done";
          document.getElementById("list")?.appendChild(done);
        });
        return "dispatched";
      },
      condition,
      { timeoutMs: 5_000 },
    );
    expect(measured).toMatchObject({ result: "dispatched", conditionMet: true });
    expect(measured.conditionMs).toBeGreaterThanOrEqual(30);
    await expect(measureAfter(fakePage, async () => undefined, condition)).rejects.toThrow(
      /already holds/,
    );
    expect((window as unknown as { __vxAfter?: unknown }).__vxAfter).toBeUndefined();
  });

  it("gives up at the timeout and says the condition never held", async () => {
    document.body.innerHTML = "";
    const measured = await measureAfter(fakePage, async () => 1, "false", { timeoutMs: 200 });
    expect(measured).toMatchObject({ conditionMet: false, conditionMs: null });
  });
});

describe("recording a dialog as it fades", () => {
  it("keeps one frame per change until the dialog is gone", async () => {
    document.body.innerHTML = `<div class="modal fade in"><h4 class="modal-title">Collection installation complete</h4>
      <div class="modal-body">3 optional mods</div>
      <div class="modal-footer"><button>Install optional mods</button><button>No Thanks</button></div></div>
      <div class="modal fade in"><h4 class="modal-title">Other</h4></div>`;
    const recording = await recordDialogFade(
      fakePage,
      { text: /collection installation/i },
      async () => {
        const modal = document.querySelector(".modal") as HTMLElement;
        later(10, () => {
          modal.className = "modal fade";
          (modal.querySelector(".modal-body") as HTMLElement).textContent = "";
          (modal.querySelector("button") as HTMLButtonElement).disabled = true;
        });
        later(40, () => modal.remove());
        return "clicked";
      },
      { settleMs: 150, maxMs: 3_000 },
    );
    expect(recording.result).toBe("clicked");
    expect(recording.gone).toBe(true);
    const states = recording.frames.map((f) => f.state);
    expect(states[0]).toMatchObject({
      className: "modal fade in",
      title: "Collection installation complete",
      buttons: [
        { text: "Install optional mods", disabled: false },
        { text: "No Thanks", disabled: false },
      ],
    });
    expect(states).toContainEqual(
      expect.objectContaining({
        className: "modal fade",
        buttons: [
          { text: "Install optional mods", disabled: true },
          { text: "No Thanks", disabled: false },
        ],
      }),
    );
    expect(states.at(-1)).toBeNull();
    // Consecutive identical states are recorded once.
    const keys = states.map((state) => JSON.stringify(state));
    expect(keys.filter((k, i) => k === keys[i - 1])).toEqual([]);
  });
});
