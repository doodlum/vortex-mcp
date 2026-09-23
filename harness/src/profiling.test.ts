import { describe, expect, it } from "vitest";

import { shortUrl, summariseProfile, type CpuProfile } from "./profiling";

const frame = (functionName: string, url = "", lineNumber = 0) => ({
  functionName,
  url,
  lineNumber,
});

/** root → [idle, hot (a.js), warm (b.js), gc]; samples chosen so self times are exact. */
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
