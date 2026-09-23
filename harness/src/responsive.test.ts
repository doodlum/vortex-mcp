import { describe, expect, it } from "vitest";
import { summarise, type SweepViewportResult } from "./responsive";

describe("responsive findings", () => {
  it("distinguishes heights at the same width and deduplicates within a scan", () => {
    const issue = {
      kind: "clipped",
      selector: "#save",
      name: "Save",
      role: "button",
      detail: "clipped",
      box: { x: 0, y: 750, width: 100, height: 40 },
    };
    const results = [720, 1080].map((height) => ({
      viewport: { width: 1280, height },
      actual: { width: 1280, height },
      inner: { width: 1280, height },
      hasHorizontalOverflow: false,
      issues: height === 720 ? [issue, issue] : [],
    })) satisfies SweepViewportResult[];
    const report = summarise(results);
    expect(report.regressions).toHaveLength(1);
    expect(report.constant).toHaveLength(0);
    expect(report.regressions[0]?.viewports).toEqual([{ width: 1280, height: 720 }]);
  });
});
