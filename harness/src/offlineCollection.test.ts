import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VortexMcpClient } from "./mcpClient";
import {
  addOfflineCollection,
  collectionManifest,
  watchEvent,
  writeOfflineCollection,
} from "./offlineCollection";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-collection-"));
  dirs.push(dir);
  return dir;
};

describe("the collection manifest", () => {
  it("lists the members' plugins, as the exporter does for Bethesda games", () => {
    const manifest = collectionManifest({
      name: "C",
      gameId: "fallout4",
      members: [
        { name: "Alpha", files: { "Alpha.esp": "x", "textures/a.dds": "y" } },
        {
          name: "Beta",
          optional: true,
          files: { "Beta.esp": "x" },
          plugins: [{ name: "Beta.esp", enabled: false }],
        },
      ],
    });
    expect(manifest.plugins).toEqual([
      { name: "Alpha.esp", enabled: true },
      { name: "Beta.esp", enabled: false },
    ]);
    expect(manifest.pluginRules).toEqual({ plugins: [], groups: [] });
    expect((manifest.mods as Array<{ optional: boolean }>).map((m) => m.optional)).toEqual([
      false,
      true,
    ]);
  });

  it("writes no plugin list for a collection without plugins", () => {
    const manifest = collectionManifest({
      name: "C",
      gameId: "vortexaisandbox",
      members: [{ name: "A", files: { "a.txt": "x" } }],
    });
    expect(manifest).not.toHaveProperty("plugins");
  });

  it("bundles each member under the directory its fileExpression names", () => {
    const file = writeOfflineCollection(path.join(tempDir(), "c.zip"), {
      name: "C",
      gameId: "fallout4",
      members: [{ name: "A", files: { "A.esp": "x" } }],
    });
    const entries = unzipSync(fs.readFileSync(file));
    const manifest = JSON.parse(strFromU8(entries["collection.json"] ?? new Uint8Array())) as {
      mods: Array<{ source: { fileExpression: string } }>;
    };
    expect(manifest.mods[0]?.source.fileExpression).toBe("Bundled - A v1.0.0");
    expect(Object.keys(entries)).toContain("bundled/Bundled - A v1.0.0/A.esp");
  });
});

/** Enough of an MCP client to add a collection: queries, dispatches and one snapshot. */
function fakeVortex(downloads: string) {
  const dispatched: Array<{ action: string; args: unknown[] }> = [];
  const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === "vortex_query" && args.selector === "activeGameId") return "fallout4";
    if (tool === "vortex_query" && args.selector === "downloadPathForGame") return downloads;
    if (tool === "vortex_dispatch") {
      dispatched.push({ action: String(args.action), args: args.args as unknown[] });
      if (args.action === "start-install-download" || args.action === "start-install") {
        return "collection-mod-1";
      }
      return {};
    }
    if (tool === "ui_snapshot") {
      return {
        activeDialogs: [],
        nodeCount: 1,
        tree: [{ ref: "e1", role: "button", name: "Install Now" }],
      };
    }
    throw new Error(`unexpected ${tool}`);
  });
  return { mcp: { call } as unknown as VortexMcpClient, dispatched };
}

describe("adding an offline collection", () => {
  it("registers the archive as a download, stamps revision info, and installs from it", async () => {
    const root = tempDir();
    const downloads = path.join(root, "downloads");
    const archive = path.join(root, "My Collection.zip");
    fs.writeFileSync(archive, "zip bytes");
    const { mcp, dispatched } = fakeVortex(downloads);

    const added = await addOfflineCollection(mcp, archive, { gameVersions: ["9.9.9"] });

    expect(added.collectionModId).toBe("collection-mod-1");
    const [register, revisionId, revisionInfo, install] = dispatched;
    expect(register?.action).toBe("addLocalDownload");
    const [id, game, fileName = "", size] = (register?.args ?? []) as [
      string,
      string,
      string,
      number,
    ];
    expect([id, game, size]).toEqual([added.downloadId, "fallout4", 9]);
    expect(fs.readFileSync(path.join(downloads, fileName), "utf8")).toBe("zip bytes");
    expect(revisionId).toEqual({
      action: "setDownloadModInfo",
      args: [id, "nexus.ids.revisionId", 1],
    });
    expect(revisionInfo?.args).toEqual([
      id,
      "nexus.revisionInfo",
      { modFiles: [], gameVersions: [{ reference: "9.9.9" }] },
    ]);
    // The allowAutoEnable flag Vortex itself passes for a downloaded collection.
    expect(install).toEqual({
      action: "start-install-download",
      args: [id, false, "__CALLBACK__"],
    });
  });

  it("gives each add its own download, and keeps the old file path on request", async () => {
    const root = tempDir();
    const archive = path.join(root, "c.zip");
    fs.writeFileSync(archive, "x");
    const { mcp, dispatched } = fakeVortex(path.join(root, "downloads"));
    const a = await addOfflineCollection(mcp, archive);
    const b = await addOfflineCollection(mcp, archive);
    expect(a.downloadId).not.toBe(b.downloadId);
    expect(fs.readdirSync(path.join(root, "downloads"))).toHaveLength(2);

    dispatched.length = 0;
    const byFile = await addOfflineCollection(mcp, archive, { via: "file" });
    expect(byFile.downloadId).toBeUndefined();
    expect(dispatched.map((d) => d.action)).toEqual(["start-install"]);
    await expect(
      addOfflineCollection(mcp, archive, { via: "file", gameVersions: ["1"] }),
    ).rejects.toThrow(/needs a download/);
  });
});

describe("watching a plain event", () => {
  it("reads only what arrived after it started watching", async () => {
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "vortex_dispatch") return { listenerId: "l1" };
      if (tool === "poll_listener" && args.since === undefined) {
        return { lastSeq: 4, entries: [] };
      }
      return { lastSeq: 5, entries: [{ seq: 5, args: ["fallout4", "coll-1"] }] };
    });
    const watch = await watchEvent({ call } as unknown as VortexMcpClient, "x");
    expect(await watch?.since()).toEqual([["fallout4", "coll-1"]]);
    expect(call).toHaveBeenLastCalledWith("poll_listener", { listenerId: "l1", since: 4 });
  });

  it("is undefined when the extension cannot subscribe", async () => {
    const call = vi.fn(async () => {
      throw new Error("Unknown action");
    });
    expect(await watchEvent({ call } as unknown as VortexMcpClient, "x")).toBeUndefined();
  });
});
