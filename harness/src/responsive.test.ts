import { describe, expect, it } from "vitest";
import { summarise, viewportList, type SweepViewportResult } from "./responsive";

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

describe("--viewports from PowerShell", () => {
  it("rejoins a list PowerShell split into separate arguments", () => {
    expect(viewportList("1024x720", ["1280x720", "1920x1080"])).toBe("1024x720,1280x720,1920x1080");
    expect(viewportList("1024x720,1280x720", [])).toBe("1024x720,1280x720");
    // What pnpm.ps1 passes for an unquoted `1280x720,1024x720`, seen in the app.
    expect(viewportList("1280x720 1024x720", [])).toBe("1280x720,1024x720");
    expect(viewportList("1024x720", ["not-a-size"])).toBe("1024x720");
    expect(viewportList(undefined, ["1280x720"])).toBeUndefined();
  });
});
