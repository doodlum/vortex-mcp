import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fillFilterScript, LIBRARY_PREFIX, seedLibrary } from "./largeLibrary";
import type { VortexMcpClient } from "./mcpClient";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An MCP client for a game whose staging folder is a fresh temporary directory. */
function fakeVortex() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "large-library-"));
  dirs.push(staging);
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === "vortex_query" && args.selector === "activeGameId") return "vortexaisandbox";
    if (tool === "vortex_query" && args.selector === "activeProfile") return { id: "profile-1" };
    if (tool === "vortex_query" && args.selector === "installPathForGame") return staging;
    return null;
  });
  return { mcp: { call } as unknown as VortexMcpClient, staging, calls };
}

describe("seedLibrary", () => {
  it("writes a staging folder per mod and registers them all in one dispatch", async () => {
    const { mcp, staging, calls } = fakeVortex();
    const library = await seedLibrary(mcp, { count: 4, filesPerMod: 2 });

    expect(library.modIds).toHaveLength(4);
    expect(library.modIds.every((id) => id.startsWith(LIBRARY_PREFIX))).toBe(true);
    for (const id of library.modIds) {
      expect(fs.readdirSync(path.join(staging, id, "library"))).toHaveLength(2);
    }

    const dispatches = calls.filter((c) => c.tool === "vortex_dispatch");
    expect(dispatches).toHaveLength(1);
    const [dispatch] = dispatches;
    if (dispatch === undefined) throw new Error("no dispatch");
    expect(dispatch.args.action).toBe("addMods");
    const [gameId, mods] = dispatch.args.args as [string, Array<Record<string, unknown>>];
    expect(gameId).toBe("vortexaisandbox");
    expect(mods.map((m) => m.installationPath)).toEqual(library.modIds);
    expect(mods.every((m) => m.state === "installed")).toBe(true);

    const enabled = calls.find((c) => c.tool === "set_mods_enabled");
    expect(enabled?.args).toMatchObject({
      modIds: library.modIds,
      enabled: true,
      profileId: "profile-1",
      expectedActiveProfileId: "profile-1",
    });
  });

  it("leaves existing staging files untouched, because deployed ones are hardlinked", async () => {
    const { mcp, staging } = fakeVortex();
    const [id = ""] = (await seedLibrary(mcp, { count: 1, filesPerMod: 1 })).modIds;
    const file = path.join(staging, id, "library", `${id}-0.txt`);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);

    await seedLibrary(mcp, { count: 1, filesPerMod: 1 });

    expect(Math.abs(fs.statSync(file).mtimeMs - past.getTime())).toBeLessThan(5);
  });

  it("refuses without an active game", async () => {
    const mcp = { call: vi.fn(async () => null) } as unknown as VortexMcpClient;
    await expect(seedLibrary(mcp, { count: 1 })).rejects.toThrow(/Manage a game/);
  });
});

describe("fillFilterScript", () => {
  it("quotes the value so it cannot break out of the page script", () => {
    const script = fillFilterScript("mods", `a"); alert("x`);
    expect(script).toContain(JSON.stringify(`a"); alert("x`));
    expect(script).toContain("#table-mods");
  });
});
