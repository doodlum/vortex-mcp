import { describe, expect, it } from "vitest";

import {
  shortUrl,
  summariseProfile,
  summariseWindows,
  windowsFromMarks,
  type CpuProfile,
} from "./profiling";

const frame = (functionName: string, url = "", lineNumber = 0) => ({
  functionName,
  url,
  lineNumber,
});

/** root â†’ [idle, hot (a.js), warm (b.js), gc]; samples chosen so self times are exact. */
const profile: CpuProfile = {
  startTime: 0,
  endTime: 10_000,
  nodes: [
    { id: 1, callFrame: frame("(root)"), children: [2, 3, 4, 5] },
    { id: 2, callFrame: frame("(idle)") },
    { id: 3, callFrame: frame("hot", "file:///C:/app/src/renderer/a.js", 9) },
    { id: 4, callFrame: frame("warm", "file:///C:/app/node_modules/lib/b.js", 0) },
    { id: 5, callFrame: frame("(garbage collector)") },
  ],
  // Each sample is charged the delta that follows it.
  samples: [3, 3, 4, 2, 5, 3],
  timeDeltas: [0, 1_000, 1_000, 2_000, 5_000, 1_000, 0],
};

describe("summariseProfile", () => {
  it("ranks functions and files by self time, leaving idle out", () => {
    const summary = summariseProfile(profile);
    expect(summary.sampledMs).toBe(5);
    expect(summary.functions[0]).toEqual({
      name: "hot (src/renderer/a.js:10)",
      selfMs: 2,
      percent: 40,
    });
    expect(summary.functions.map((f) => f.name)).toContain("(garbage collector)");
    expect(summary.functions.some((f) => f.name.startsWith("(idle)"))).toBe(false);
    expect(summary.files.find((f) => f.name === "node_modules/lib/b.js")?.selfMs).toBe(2);
    expect(summary.durationMs).toBe(10);
  });

  it("copes with a profile that has no samples", () => {
    const empty = summariseProfile({ ...profile, samples: [], timeDeltas: [] });
    expect(empty.sampledMs).toBe(0);
    expect(empty.functions).toEqual([]);
  });
});

describe("shortUrl", () => {
  it("keeps the package path for dependencies and the tail for app code", () => {
    expect(shortUrl("file:///C:/x/node_modules/react-dom/cjs/react-dom.js")).toBe(
      "node_modules/react-dom/cjs/react-dom.js",
    );
    expect(shortUrl("file:///C:/dev/vx-ab/src/main/build/renderer.js")).toBe(
      "main/build/renderer.js",
    );
    expect(shortUrl("")).toBe("(native)");
  });
});

/**
 * root → outer (app) → inner (app) → workLoop (react-dom), plus idle and GC. Sample weights are
 * the delta after each sample: inner 1 ms, workLoop 2 + 1 ms, idle 3 ms, outer 1 ms, GC 1 ms.
 */
const tree: CpuProfile = {
  startTime: 0,
  endTime: 10_000,
  nodes: [
    { id: 1, callFrame: frame("(root)"), children: [2, 3, 7] },
    { id: 2, callFrame: frame("(idle)") },
    { id: 3, callFrame: frame("outer", "file:///C:/vx/src/app/a.js", 0), children: [4] },
    { id: 4, callFrame: frame("inner", "file:///C:/vx/src/app/a.js", 4), children: [5] },
    { id: 5, callFrame: frame("workLoop", "file:///C:/vx/node_modules/react-dom/x.js", 9) },
    { id: 7, callFrame: frame("(garbage collector)") },
  ],
  samples: [4, 5, 5, 2, 3, 7, 2],
  timeDeltas: [0, 1_000, 2_000, 1_000, 3_000, 1_000, 1_000],
};

describe("inclusive time", () => {
  it("charges each function for everything it called, once per sample", () => {
    const summary = summariseProfile(tree);
    expect(summary.inclusive.map((s) => [s.name, s.inclusiveMs, s.selfMs])).toEqual([
      ["outer (src/app/a.js:1)", 5, 1],
      ["inner (src/app/a.js:5)", 4, 1],
      ["workLoop (node_modules/react-dom/x.js:10)", 3, 3],
      ["(garbage collector)", 1, 1],
    ]);
    expect(summary.inclusive[0]?.percent).toBe(83.3);
    // The app's own tree: no dependencies, no GC.
    expect(summary.inclusiveApp.map((s) => s.name)).toEqual([
      "outer (src/app/a.js:1)",
      "inner (src/app/a.js:5)",
    ]);
  });

  it("finds the longest stretch without idle, and what it spent it on", () => {
    expect(summariseProfile(tree).longestBusy).toEqual({
      startMs: 0,
      ms: 4,
      top: [
        { name: "inner (src/app/a.js:5)", inclusiveMs: 4, selfMs: 1, percent: 100 },
        { name: "outer (src/app/a.js:1)", inclusiveMs: 4, selfMs: 0, percent: 100 },
      ],
    });
  });

  it("splits a profile at marks and summarises each window", () => {
    const windows = windowsFromMarks([{ name: "review-shown", atMs: 5 }], 10);
    expect(windows).toEqual([
      { name: "start -> review-shown", startMs: 0, endMs: 5 },
      { name: "review-shown -> end", startMs: 5, endMs: 10 },
    ]);
    const [before, after] = summariseWindows(tree, windows);
    expect(before).toMatchObject({ busyMs: 4, longestBusy: { startMs: 0, ms: 4 } });
    expect(after).toMatchObject({
      busyMs: 2,
      top: [{ name: "outer (src/app/a.js:1)", inclusiveMs: 1 }],
      longestBusy: { startMs: 7, ms: 2 },
    });
  });
});
