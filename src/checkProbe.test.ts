import { describe, expect, it } from "vitest";

import { PROBED_EVENTS, probeCounts, probeFor, registerCheckProbes } from "./checkProbe";

describe("check probes", () => {
  it("registers one namespaced probe per event", () => {
    const registered: Array<[string, string]> = [];
    registerCheckProbes((id, event) => registered.push([id, event]));
    expect(registered.map(([, event]) => event)).toEqual([...PROBED_EVENTS]);
    expect(registered.every(([id]) => id.startsWith("vortex-mcp-probe-"))).toBe(true);
  });

  it("does nothing without registerTest", () => {
    expect(() => registerCheckProbes(undefined)).not.toThrow();
  });

  it("finds nothing and counts every run", async () => {
    const before = probeCounts().find((c) => c.event === "plugins-changed")?.runs ?? 0;
    await expect(probeFor("plugins-changed")()).resolves.toBeUndefined();
    await probeFor("plugins-changed")();
    const after = probeCounts().find((c) => c.event === "plugins-changed");
    expect(after?.runs).toBe(before + 2);
    expect(after?.lastRun).not.toBeNull();
  });
});
