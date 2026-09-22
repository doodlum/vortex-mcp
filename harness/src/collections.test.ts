import { describe, expect, it, vi } from "vitest";

import { modsStillInstalling } from "./deployment";
import type { VortexMcpClient } from "./mcpClient";

function mcpWithMods(
  mods: Record<string, { id: string; name?: string; state?: string; type?: string }>,
) {
  return {
    call: vi.fn(async () => mods),
  } as unknown as VortexMcpClient;
}

describe("modsStillInstalling", () => {
  it("reports mods whose installer has not finished", async () => {
    // A mod is in state from the moment its install STARTS. It sits at
    // "installing" — archive filename, disabled — until its installer
    // completes, which for a FOMOD means until someone answers the wizard.
    // Treating its presence as success is what let a collection report itself
    // complete while four installers were still open.
    const mcp = mcpWithMods({
      a: { id: "a", name: "FallUI - Map", state: "installed" },
      b: { id: "b", name: "FallUI - HUD-51813-1-7-1", state: "installing" },
      c: { id: "c", name: "FIS - Item Sorter-60580", state: "installing" },
    });

    const pending = await modsStillInstalling(mcp, "fallout4");

    expect(pending.map((m) => m.name)).toEqual([
      "FallUI - HUD-51813-1-7-1",
      "FIS - Item Sorter-60580",
    ]);
  });

  it("is empty once everything has finished", async () => {
    const mcp = mcpWithMods({
      a: { id: "a", state: "installed" },
      b: { id: "b", state: "installed", type: "collection" },
    });
    await expect(modsStillInstalling(mcp, "fallout4")).resolves.toEqual([]);
  });

  it("treats an unreadable state as nothing pending rather than throwing", async () => {
    // Blocking a deploy because a query failed would be worse than the problem;
    // the guard is a safety net, not the source of truth.
    const mcp = {
      call: vi.fn(async () => {
        throw new Error("nope");
      }),
    } as unknown as VortexMcpClient;
    await expect(modsStillInstalling(mcp, "fallout4")).resolves.toEqual([]);
  });
});
