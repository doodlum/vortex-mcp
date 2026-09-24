import path from "node:path";

import { describe, expect, it } from "vitest";

import { isHarnessProfile } from "./rendererEval";

describe("renderer eval's instance check", () => {
  const cache = path.resolve("C:/cache/vortex-ai");

  it("accepts only a profile inside the harness cache", () => {
    expect(isHarnessProfile(cache, path.join(cache, "live", "userData"))).toBe(true);
    expect(isHarnessProfile(cache, cache)).toBe(false);
    expect(isHarnessProfile(cache, path.resolve("C:/Users/me/AppData/Roaming/Vortex"))).toBe(false);
    expect(isHarnessProfile(cache, path.resolve("C:/cache/vortex-ai-other/live"))).toBe(false);
    expect(isHarnessProfile(cache, null)).toBe(false);
    expect(isHarnessProfile(cache, "")).toBe(false);
  });
});
