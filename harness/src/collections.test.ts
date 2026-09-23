import { describe, expect, it, vi } from "vitest";

import { modsStillInstalling } from "./deployment";
import type { VortexMcpClient } from "./mcpClient";
import {
  findCollectionMod,
  parseCollectionRef,
  resolveCollection,
  throwOnCollectionErrors,
} from "./collections";

describe("collection identity", () => {
  it("fails on new dependency errors while ignoring stale notifications", async () => {
    const mcp = {
      call: vi.fn(async () => [
        { id: "old", type: "error", title: "Failed to look up dependency", message: "old failure" },
      ]),
    } as unknown as VortexMcpClient;
    await expect(throwOnCollectionErrors(mcp, new Set(["old"]))).resolves.toBeUndefined();
    await expect(throwOnCollectionErrors(mcp, new Set())).rejects.toThrow(
      /profile and downloads are preserved/,
    );
  });
  it("rejects lookalike domains and malformed slugs", () => {
    expect(() =>
      parseCollectionRef("https://evilnexusmods.com/fallout4/collections/test"),
    ).toThrow();
    expect(() => parseCollectionRef('nxm://fallout4/collections/x"}')).toThrow();
    expect(
      parseCollectionRef("https://www.nexusmods.com/games/fallout4/collections/pmmttm/revisions/2"),
    ).toEqual({ gameId: "fallout4", slug: "pmmttm", revision: 2 });
  });
  it("does not resume a different collection or revision", async () => {
    const mcp = {
      call: vi.fn(async () => ({
        wrong: {
          id: "wrong",
          type: "collection",
          attributes: { collectionSlug: "other", revisionNumber: 2 },
        },
        old: {
          id: "old",
          type: "collection",
          attributes: { collectionSlug: "wanted", revisionNumber: 1 },
        },
        correct: {
          id: "correct",
          type: "collection",
          attributes: { collectionSlug: "wanted", revisionNumber: 2 },
        },
      })),
    } as unknown as VortexMcpClient;
    expect(
      (await findCollectionMod(mcp, { gameId: "fallout4", slug: "wanted", revision: 2 }))?.id,
    ).toBe("correct");
  });
  it("uses the requested revision's id as well as its revision number", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            collection: {
              id: 1,
              name: "test",
              currentRevision: { id: 99, revisionNumber: 9, modCount: 99 },
            },
            requested: { id: 22, revisionNumber: 2, modCount: 3 },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      expect(
        await resolveCollection({ gameId: "fallout4", slug: "wanted", revision: 2 }),
      ).toMatchObject({ revisionId: 22, revisionNumber: 2, modCount: 3 });
    } finally {
      fetcher.mockRestore();
    }
  });
});

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

  it("refuses to certify installation when state cannot be read", async () => {
    const mcp = {
      call: vi.fn(async () => {
        throw new Error("nope");
      }),
    } as unknown as VortexMcpClient;
    await expect(modsStillInstalling(mcp, "fallout4")).rejects.toThrow("nope");
  });
});
