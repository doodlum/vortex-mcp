import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VortexMcpClient } from "./mcpClient";
import {
  addOfflineCollection,
  buttonInEntry,
  collectionManifest,
  completeOptionalsWithoutInstall,
  modWithTag,
  reviewDialogsFor,
  standInOptionals,
  updateOfflineCollection,
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

  it("writes inter-member modRules and a member's own fileExpression", () => {
    const rule = { source: { tag: "a" }, type: "before", reference: { fileExpression: "B*" } };
    const manifest = collectionManifest({
      name: "C",
      gameId: "vortexaisandbox",
      members: [{ name: "lib-00012", files: {}, fileExpression: "Bundled - lib-0001?*" }],
      modRules: [rule],
    });
    expect(manifest.modRules).toEqual([rule]);
    expect(
      (manifest.mods as Array<{ source: { fileExpression: string } }>)[0]?.source,
    ).toMatchObject({ fileExpression: "Bundled - lib-0001?*" });
    expect(collectionManifest({ name: "C", gameId: "g", members: [] }).modRules).toEqual([]);
  });
});

describe("updating an offline collection", () => {
  it("removes the old collection mod as collectionUpdate does, then installs the new revision", async () => {
    const root = tempDir();
    const archive = path.join(root, "rev2.zip");
    fs.writeFileSync(archive, "zip");
    const { mcp: base, dispatched } = fakeVortex(path.join(root, "downloads"));
    const stop = new Error("stop at Install Now");
    const mcp = {
      call: async (tool: string, args: Record<string, unknown>) => {
        if (tool === "poll_listener") return { lastSeq: 0, entries: [] };
        if (tool === "vortex_dispatch" && args.action === "onEvent") return { listenerId: "l1" };
        if (tool === "ui_click") throw stop;
        return base.call(tool, args);
      },
    } as unknown as VortexMcpClient;

    await expect(
      updateOfflineCollection(mcp, "collection-rev1", archive, { keep: ["m1"], remove: ["m2"] }),
    ).rejects.toBe(stop);
    expect(dispatched.map((d) => d.action)).toEqual([
      "setModAttribute",
      "remove-mods",
      "addLocalDownload",
      "start-install-download",
    ]);
    expect(dispatched[0]?.args).toEqual(["fallout4", "m1", "installedAsDependency", false]);
    expect(dispatched[1]?.args).toEqual([
      "fallout4",
      ["collection-rev1", "m2"],
      "__CALLBACK__",
      { incomplete: true, ignoreInstalling: true, reason: "collection_update" },
    ]);
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
    // The Install Now dialog, found without a full snapshot.
    if (tool === "ui_active_dialogs") return ["Install Now"];
    if (tool === "ui_snapshot") {
      return {
        activeDialogs: ["Install Now"],
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

describe("standing in for an optionals pass", () => {
  const collection = {
    type: "collection",
    rules: [
      { type: "requires", reference: { tag: "req" } },
      { type: "recommends", reference: { tag: "opt-installed" } },
      { type: "recommends", reference: { tag: "opt-a", description: "Opt A" } },
      { type: "recommends", reference: { tag: "opt/b" } },
      { type: "recommends", reference: { tag: "opt-a" } },
    ],
  };
  const mods = {
    coll: collection,
    m1: { attributes: { referenceTags: ["opt-installed"] } },
  };

  it("adds one mod per optional member nothing installed carries the tag of", () => {
    expect(standInOptionals(collection, mods)).toEqual([
      { id: "vortex-mcp-optional-opt-a", tag: "opt-a", name: "Opt A" },
      { id: "vortex-mcp-optional-opt_b", tag: "opt/b", name: "opt/b" },
    ]);
    expect(modWithTag(mods, "opt-installed")).toBe("m1");
  });

  it("adds the mods, marks the session's optional entries installed and ends the pass", async () => {
    const staging = tempDir();
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (tool === "vortex_query" && args.selector === "activeGameId") return "vortexaisandbox";
      if (tool === "vortex_query" && args.selector === "installPathForGame") return staging;
      if (tool === "vortex_query" && args.selector === "activeProfile") return { id: "p1" };
      if (tool === "vortex_query" && (args.path as string[])[0] === "persistent") return mods;
      if (tool === "vortex_query") {
        return {
          sessionId: "s1",
          mods: {
            recommends_a: { type: "recommends", status: "pending" },
            recommends_done: { type: "recommends", status: "installed" },
            requires_x: { type: "requires", status: "pending" },
          },
        };
      }
      return {};
    });
    const result = await completeOptionalsWithoutInstall(
      { call } as unknown as VortexMcpClient,
      "coll",
    );
    expect(result).toEqual({
      added: ["vortex-mcp-optional-opt-a", "vortex-mcp-optional-opt_b"],
      marked: 1,
      sessionId: "s1",
    });
    expect(fs.existsSync(path.join(staging, "vortex-mcp-optional-opt-a"))).toBe(true);
    const dispatched = calls.filter((c) => c.tool === "vortex_dispatch").map((c) => c.args);
    expect(dispatched.map((d) => d.action)).toEqual([
      "addMods",
      "type:COLLECTION_UPDATE_MOD_STATUS",
      "did-install-dependencies",
    ]);
    expect(dispatched[1]?.args).toEqual([
      { sessionId: "s1", ruleId: "recommends_a", status: "installed" },
    ]);
    expect(dispatched[2]?.args).toEqual(["vortexaisandbox", "coll", true]);
    const added = (
      dispatched[0]?.args as [string, Array<{ attributes: unknown }>] | undefined
    )?.[1];
    expect(added?.[0]?.attributes).toMatchObject({
      referenceTag: "opt-a",
      referenceTags: ["opt-a"],
    });
    expect(calls.some((c) => c.tool === "set_mods_enabled")).toBe(true);
  });

  it("counts the review screens a collection has open", async () => {
    const call = vi.fn(async () => ({
      dialogs: [
        { step: "review", collectionId: "a" },
        { step: "review", collectionId: "b" },
        { step: "query", collectionId: "a" },
      ],
    }));
    expect(await reviewDialogsFor({ call } as unknown as VortexMcpClient, "a")).toBe(1);
  });
});

const entry = (ref: string, title: string, message: string) => ({
  ref: `${ref}0`,
  role: "div",
  children: [
    { ref: `${ref}1`, role: "p", text: title },
    { ref: `${ref}2`, role: "div", text: message },
    { ref: `${ref}3`, role: "button", name: "Resume" },
    { ref: `${ref}4`, role: "button", name: "Disable" },
  ],
});

describe("finding one notification's button", () => {
  it("takes Resume from the entry naming the collection, not another entry's", () => {
    const panel = [
      {
        ref: "p",
        role: "div",
        children: [
          entry("a", "Collection incomplete", "Other collection"),
          entry("b", "Collection incomplete", "Kit Verify"),
        ],
      },
    ];
    expect(buttonInEntry(panel, ["Collection incomplete", "Kit Verify"], /^resume$/i)?.ref).toBe(
      "b3",
    );
    expect(buttonInEntry(panel, ["Collection incomplete", "Missing"], /^resume$/i)).toBeUndefined();
  });

  it("reads a popover flattened into siblings, with zero-width spaces in the name", () => {
    // What a snapshot scoped to Vortex's notification popover returns.
    const flat = [
      { ref: "t1", role: "p", text: "Collection incomplete" },
      { ref: "m1", role: "span", text: "Other \u200bOne" },
      { ref: "r1", role: "button", name: "Resume" },
      { ref: "d1", role: "button", name: "Dismiss" },
      { ref: "t2", role: "p", text: "Collection incomplete" },
      { ref: "m2", role: "span", text: "Kit \u200bVerify \u200br4" },
      { ref: "r2", role: "button", name: "Resume" },
    ];
    expect(buttonInEntry(flat, ["Collection incomplete", "Kit Verify r4"], /^resume$/i)?.ref).toBe(
      "r2",
    );
  });
});
