// @vitest-environment jsdom
//
// jsdom has no layout, so every box is stubbed explicitly; what is tested is the page code's
// own logic: which rows count as on screen, which ancestor counts as the scroller, and the
// verdicts drawn from the numbers.
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFLICT_EDITOR_COUNTS,
  columnWidthsSource,
  dropdownVerdict,
  rowsOnScreenSource,
  scrollToSource,
  shrinkingSamples,
  summariseFrames,
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
