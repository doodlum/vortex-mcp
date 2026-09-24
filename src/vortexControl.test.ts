import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setNextProfile: vi.fn((id: string) => ({ type: "SET_NEXT_PROFILE", payload: id })),
    setModsEnabled: vi.fn(async () => undefined),
    setProfile: vi.fn((profile: unknown) => ({ type: "SET_PROFILE", payload: profile })),
    setLoadOrder: vi.fn((order: unknown) => ({ type: "SET_LOAD_ORDER", payload: order })),
    setGamePath: vi.fn((gamePath: unknown) => ({ type: "SET_GAME_PATH", payload: gamePath })),
    removeProfile: vi.fn((profileId: string) => ({ type: "REMOVE_PROFILE", payload: profileId })),
    closeDialog: vi.fn(
      (id: string, actionKey?: string) => (dispatch: (a: unknown) => void) =>
        dispatch({ type: "CLOSE_DIALOG_THUNK_RAN", id, actionKey }),
    ),
  },
  selectors: {
    activeProfileId: vi.fn<() => string | undefined>(),
    activeProfile: vi.fn<() => unknown>(),
    profiles: vi.fn<() => Record<string, unknown>>(),
    activeGameId: vi.fn<() => string | undefined>(),
    // Default covers every gameId literal used across this file's tests; the
    // resolveGameId-specific tests override this to exercise the unknown-gameId path.
    knownGames: vi.fn<() => Array<{ id: string }>>(() => [
      { id: "skyrimse" },
      { id: "skyrimvr" },
      { id: "fallout4" },
    ]),
    notifications: vi.fn<() => unknown[]>(),
    installPathForGame: vi.fn<(state: unknown, gameId: string) => string | undefined>(),
  },
  util: {
    renderModName: vi.fn((mod: { id: string }) => mod.id),
    getVortexPath: vi.fn(() => "C:\\fake\\userData"),
    writeFileAtomic: vi.fn(async () => undefined),
    toPromise: vi.fn(
      (fn: (cb: (err: Error | null, result?: unknown) => void) => void) =>
        new Promise((resolve, reject) => {
          fn((err, result) => (err ? reject(err) : resolve(result)));
        }),
    ),
  },
  fs: {
    ensureDirAsync: vi.fn(async () => undefined),
    ensureDirWritableAsync: vi.fn(async () => undefined),
    copyAsync: vi.fn(async () => undefined),
  },
  log: vi.fn(),
}));

import { actions, fs, selectors, util } from "@nexusmods/vortex-api";
import {
  backupState,
  checkNexusModUpdates,
  cloneProfile,
  describeApi,
  dispatchAction,
  findMissingDeployedFiles,
  findMissingMasters,
  findModByFile,
  findModDependents,
  findOrphanedFiles,
  findStaleDownloads,
  findStaleMods,
  getPluginDetails,
  launchGame,
  listCategories,
  listDialogs,
  listDownloads,
  listExternalChanges,
  listDuplicateMods,
  listFileConflicts,
  listKnownModConflicts,
  listLoadOrder,
  listModRules,
  listMods,
  listNotifications,
  listProfiles,
  listRuntimeErrors,
  listUnsolvedConflicts,
  pollListener,
  queryStatePath,
  querySelector,
  restartVortex,
  scanExtensionActions,
  setModsEnabled,
  switchProfile,
} from "./vortexControl";

function fakeApi(
  overrides: Partial<{
    dispatch: (a: unknown) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches EventEmitter.emit's own (...args: any[]) signature
    emit: (...args: any[]) => void;
  }> = {},
) {
  return {
    store: {
      getState: () => ({}),
      dispatch: overrides.dispatch ?? vi.fn(),
    },
    events: {
      emit: overrides.emit ?? vi.fn(),
      on: vi.fn(),
      eventNames: vi.fn(() => []),
      listenerCount: vi.fn(() => 1),
    },
  } as never;
}

describe("vortexControl: reflection", () => {
  it("describeApi lists the live selector/action/state-key names", () => {
    vi.mocked(selectors.activeProfileId).mockReturnValue("p1");

    const result = describeApi(fakeApi());

    expect(result.selectors).toContain("activeProfileId");
    expect(result.selectors).toContain("profiles");
    // Every action is dispatchable now (no allowlist) — `actions` itself is the
    // "what's callable" list; dispatchHints is documentation for a verified subset.
    expect(result.actions).toContain("setNextProfile");
    expect(result.actions).toContain("setLoadOrder");
    expect(result.stateKeys).toEqual([]);
    expect(result.dispatchHints.setModEnabled).toBe(
      "profileId: string, modId: string, enable: boolean",
    );
    expect(result.dispatchHints).not.toHaveProperty("setNextProfile");
    expect(result.dispatchHints["type:SET_PLUGIN_ENABLED"]).toContain("pluginName");
    expect(result.extensionApis).toEqual([]);
    expect(result.extensionApiHints.nexusGetModInfo).toContain("gameId: string");
    expect(result.extensionApiHints.nexusSearchCollections).toContain("OPTIONS OBJECT");
    expect(result.eventHints["deploy-mods"]).toContain("__CALLBACK__");
    expect(result.eventHints["autosort-plugins"]).toContain("ACTIVE profile");
    expect(result.extensionApiHints.lootSortAsync).toContain("pluginFilePaths");
    expect(result.listenerHints.onStateChange).toContain("__CALLBACK__");
    expect(result.selectorHints.knownGames).toContain("discovered");
    expect(result.selectorHints.gameProfiles).toContain("does not filter");
    expect(result.selectorHints.downloadsForGame).toContain("list_downloads");
    expect(result.selectorHints.getDownloadByIds).toContain("null");
  });

  it("describeApi surfaces api.ext names as extensionApis without exposing the functions", () => {
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {
      someExtensionHelper: () => undefined,
    };

    expect(describeApi(api).extensionApis).toEqual(["someExtensionHelper"]);
  });

  it("describeApi surfaces api's own direct methods (apiMethods) and registered event names", () => {
    const api = fakeApi();
    (api as unknown as { runExecutable: () => void; translate: () => void }).runExecutable = () =>
      undefined;
    (api as unknown as { runExecutable: () => void; translate: () => void }).translate = () =>
      undefined;
    (api as unknown as { events: { eventNames: () => string[] } }).events.eventNames = () => [
      "deploy-mods",
      "purge-mods",
    ];

    const result = describeApi(api);

    expect(result.apiMethods).toEqual(expect.arrayContaining(["runExecutable", "translate"]));
    expect(result.eventNames).toEqual(["deploy-mods", "purge-mods"]);
  });

  it("querySelector calls the named selector with state and extra args", () => {
    vi.mocked(selectors.profiles).mockReturnValue({ p1: { id: "p1" } as never });

    expect(querySelector(fakeApi(), "profiles")).toEqual({ p1: { id: "p1" } });
  });

  it("querySelector throws for an unknown selector name", () => {
    expect(() => querySelector(fakeApi(), "notARealSelector")).toThrow(/Unknown selector/);
  });

  it("queryStatePath walks the state tree by key", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: { modA: { id: "modA" } } } },
    });

    expect(queryStatePath(api, ["persistent", "mods", "skyrimse", "modA"])).toEqual({
      id: "modA",
    });
  });

  it("queryStatePath returns undefined for a path that doesn't resolve", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({});

    expect(queryStatePath(api, ["nope", "deeper"])).toBeUndefined();
  });
});

describe("vortexControl: profiles", () => {
  it("switchProfile rejects unknown profile ids without dispatching", () => {
    vi.mocked(selectors.profiles).mockReturnValue({});
    const dispatch = vi.fn();

    expect(() => switchProfile(fakeApi({ dispatch }), "missing")).toThrow(/Unknown profile/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("switchProfile dispatches setNextProfile for a known profile", () => {
    vi.mocked(selectors.profiles).mockReturnValue({
      p1: { id: "p1", name: "First", gameId: "skyrimse", modState: {}, lastActivated: 0 },
    });
    const dispatch = vi.fn();

    switchProfile(fakeApi({ dispatch }), "p1");

    expect(actions.setNextProfile).toHaveBeenCalledWith("p1");
    expect(dispatch).toHaveBeenCalled();
  });

  it("switchProfile throws instead of dispatching when expectedActiveProfileId no longer matches", () => {
    // Regression test for a real cold-run incident: the active profile silently reverted
    // mid-analysis (Vortex's own UI, another agent, anything) with zero signal from any
    // read tool. A caller that captured the active profile earlier can assert it's still
    // true right before a write instead of silently acting on a stale assumption.
    vi.mocked(selectors.profiles).mockReturnValue({
      p1: { id: "p1", name: "First", gameId: "skyrimse", modState: {}, lastActivated: 0 },
    });
    vi.mocked(selectors.activeProfileId).mockReturnValue("someOtherProfile");
    const dispatch = vi.fn();

    expect(() =>
      switchProfile(fakeApi({ dispatch }), "p1", { activeProfileId: "expectedProfile" }),
    ).toThrow(/Active profile changed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("switchProfile proceeds when expectedActiveProfileId matches", () => {
    vi.mocked(selectors.profiles).mockReturnValue({
      p1: { id: "p1", name: "First", gameId: "skyrimse", modState: {}, lastActivated: 0 },
    });
    vi.mocked(selectors.activeProfileId).mockReturnValue("currentProfile");
    const dispatch = vi.fn();

    switchProfile(fakeApi({ dispatch }), "p1", { activeProfileId: "currentProfile" });

    expect(dispatch).toHaveBeenCalled();
  });

  it("cloneProfile rejects an unknown source profile without touching disk", async () => {
    vi.mocked(selectors.profiles).mockReturnValue({});

    await expect(cloneProfile(fakeApi(), "missing")).rejects.toThrow(/Unknown profile/);
    expect(fs.copyAsync).not.toHaveBeenCalled();
  });

  it("cloneProfile copies the source profile dir and dispatches setProfile with a new id", async () => {
    const source = {
      id: "p1",
      name: "AE 1.7",
      gameId: "skyrimse",
      modState: { modA: { enabled: true, enabledTime: 0 } },
      lastActivated: 0,
    };
    vi.mocked(selectors.profiles).mockReturnValue({ p1: source });
    const dispatch = vi.fn();

    const result = await cloneProfile(fakeApi({ dispatch }), "p1");

    expect(result.id).not.toBe("p1");
    expect(result.name).toBe("AE 1.7 (clone)");
    expect(result.gameId).toBe("skyrimse");
    expect(result.active).toBe(false);
    expect(fs.copyAsync).toHaveBeenCalledWith(
      expect.stringContaining(path.join("skyrimse", "profiles", "p1")),
      expect.stringContaining(path.join("skyrimse", "profiles", result.id)),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_PROFILE",
        payload: expect.objectContaining({
          id: result.id,
          name: "AE 1.7 (clone)",
          modState: source.modState,
        }),
      }),
    );
  });

  it("cloneProfile accepts an explicit name", async () => {
    vi.mocked(selectors.profiles).mockReturnValue({
      p1: { id: "p1", name: "AE 1.7", gameId: "skyrimse", modState: {}, lastActivated: 0 },
    });

    const result = await cloneProfile(fakeApi(), "p1", "MCP test");

    expect(result.name).toBe("MCP test");
  });

  it("listProfiles summarizes every profile without dumping full modState, sorted by lastActivated", () => {
    vi.mocked(selectors.profiles).mockReturnValue({
      old: {
        id: "old",
        name: "Old",
        gameId: "skyrimse",
        modState: { modA: { enabled: true, enabledTime: 0 } },
        lastActivated: 100,
      },
      recent: {
        id: "recent",
        name: "Recent",
        gameId: "skyrimse",
        modState: {
          modA: { enabled: true, enabledTime: 0 },
          modB: { enabled: false, enabledTime: 0 },
        },
        lastActivated: 200,
      },
      removing: {
        id: "removing",
        name: "Being removed",
        gameId: "skyrimse",
        modState: {},
        lastActivated: 50,
        pendingRemove: true,
      },
    });
    vi.mocked(selectors.activeProfileId).mockReturnValue("recent");

    const result = listProfiles(fakeApi());

    expect(result).toEqual([
      {
        id: "recent",
        name: "Recent",
        gameId: "skyrimse",
        active: true,
        modCount: 2,
        enabledModCount: 1,
        lastActivated: 200,
      },
      {
        id: "old",
        name: "Old",
        gameId: "skyrimse",
        active: false,
        modCount: 1,
        enabledModCount: 1,
        lastActivated: 100,
      },
    ]);
  });

  it("listProfiles filters to the given gameId", () => {
    vi.mocked(selectors.profiles).mockReturnValue({
      se: { id: "se", name: "SE", gameId: "skyrimse", modState: {}, lastActivated: 0 },
      vr: { id: "vr", name: "VR", gameId: "skyrimvr", modState: {}, lastActivated: 0 },
    });

    const result = listProfiles(fakeApi(), "skyrimvr");

    expect(result.map((p) => p.id)).toEqual(["vr"]);
  });
});

describe("vortexControl: resolveGameId (via listMods)", () => {
  it("throws a clear error for a gameId not in Vortex's known-games catalog", () => {
    vi.mocked(selectors.activeProfile).mockReturnValue(undefined as never);

    expect(() => listMods(fakeApi(), "not-a-real-game-12345")).toThrow(
      /Unknown gameId: "not-a-real-game-12345"/,
    );
  });

  it("accepts a gameId that is in the known-games catalog even if it has no mods", () => {
    vi.mocked(selectors.activeProfile).mockReturnValue(undefined as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: {} },
    });

    expect(listMods(api, "fallout4")).toEqual([]);
  });
});

describe("vortexControl: mods", () => {
  it("listMods reads the active game's mods and marks enabled state from the active profile", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      id: "p1",
      name: "First",
      gameId: "skyrimse",
      modState: { modA: { enabled: true, enabledTime: 0 } },
      lastActivated: 0,
    });

    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              state: "installed",
              type: "",
              installationPath: "",
              attributes: { version: "1.0" },
            },
            modB: { id: "modB", state: "installed", type: "", installationPath: "" },
          },
        },
      },
    });

    const result = listMods(api);

    expect(result).toEqual([
      { id: "modA", name: "modA", type: "", version: "1.0", enabled: true },
      { id: "modB", name: "modB", type: "", version: undefined, enabled: false },
    ]);
  });

  it("listMods throws when there is no active game and none was provided", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("");

    expect(() => listMods(fakeApi())).toThrow(/No active game/);
  });

  it("listMods filters by enabledOnly, nameFilter, and limit", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      id: "p1",
      name: "First",
      gameId: "skyrimse",
      modState: {
        modA: { enabled: true, enabledTime: 0 },
        modC: { enabled: true, enabledTime: 0 },
      },
      lastActivated: 0,
    });

    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: { id: "modA", state: "installed", type: "", installationPath: "" },
            modB: { id: "modB", state: "installed", type: "", installationPath: "" },
            modC: { id: "modC", state: "installed", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listMods(api, undefined, { enabledOnly: true })).toEqual([
      { id: "modA", name: "modA", type: "", version: undefined, enabled: true },
      { id: "modC", name: "modC", type: "", version: undefined, enabled: true },
    ]);
    expect(listMods(api, undefined, { nameFilter: "MODB" })).toEqual([
      { id: "modB", name: "modB", type: "", version: undefined, enabled: false },
    ]);
    expect(listMods(api, undefined, { limit: 1 })).toHaveLength(1);
  });

  it("setModsEnabled uses an explicit profileId over the active one", async () => {
    await setModsEnabled(fakeApi(), ["modA"], false, "p-explicit");

    expect(actions.setModsEnabled).toHaveBeenCalledWith(
      expect.anything(),
      "p-explicit",
      ["modA"],
      false,
    );
  });

  it("setModsEnabled throws when there is no active profile and none was provided", async () => {
    vi.mocked(selectors.activeProfileId).mockReturnValue(undefined);

    await expect(setModsEnabled(fakeApi(), ["modA"], true)).rejects.toThrow(/No active profile/);
  });

  it("setModsEnabled rejects when expectedActiveProfileId no longer matches, without calling the action", async () => {
    vi.mocked(selectors.activeProfileId).mockReturnValue("someOtherProfile");
    vi.mocked(actions.setModsEnabled).mockClear();

    await expect(
      setModsEnabled(fakeApi(), ["modA"], true, "p-explicit", {
        activeProfileId: "expectedProfile",
      }),
    ).rejects.toThrow(/Active profile changed/);
    expect(actions.setModsEnabled).not.toHaveBeenCalled();
  });
});

describe("vortexControl: listLoadOrder", () => {
  it("sorts plugins by index and defaults enabled to true when absent", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      loadOrder: {
        "update.esm": { loadOrder: 1 },
        "skyrim.esm": { loadOrder: 0 },
        "mymod.esp": { loadOrder: 2, enabled: false },
      },
    });

    expect(listLoadOrder(api)).toEqual([
      { plugin: "skyrim.esm", index: 0, enabled: true },
      { plugin: "update.esm", index: 1, enabled: true },
      { plugin: "mymod.esp", index: 2, enabled: false },
    ]);
  });

  it("throws when there is no load order data", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({});

    expect(() => listLoadOrder(api)).toThrow(/No plugin load order/);
  });
});

describe("vortexControl: getPluginDetails", () => {
  it("merges load order, the cached base record, and the real LOOT lookup result into one summary", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const emit = vi.fn((name: string, ...rest: unknown[]) => {
      if (name === "plugin-details") {
        // Regression: plugin-details' real callback is (result) => void, a single
        // argument -- not the (err, result?) convention CALLBACK_SENTINEL assumes.
        const cb = rest[rest.length - 1] as (result: unknown) => void;
        cb({
          "foo.esp": {
            group: "default",
            version: "1.0",
            messages: [{ type: "warn", text: "test" }],
            dirtyness: [{}],
          },
        });
      }
    });
    const api = fakeApi({ emit });
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      loadOrder: { "foo.esp": { loadOrder: 0, enabled: true } },
      session: {
        plugins: { pluginList: { "foo.esp": { modId: "modA", deployed: true, isNative: false } } },
      },
    });

    const result = await getPluginDetails(api, ["foo.esp"]);

    expect(result).toEqual([
      {
        plugin: "foo.esp",
        index: 0,
        enabled: true,
        modId: "modA",
        deployed: true,
        isNative: false,
        group: "default",
        version: "1.0",
        messages: [{ type: "warn", text: "test" }],
        dirty: true,
      },
    ]);
    expect(emit).toHaveBeenCalledWith(
      "plugin-details",
      "skyrimse",
      ["foo.esp"],
      expect.any(Function),
    );
  });

  it("falls back to index -1 and undefined fields for a plugin missing from every source", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const emit = vi.fn((name: string, ...rest: unknown[]) => {
      if (name === "plugin-details") {
        const cb = rest[rest.length - 1] as (result: unknown) => void;
        cb({});
      }
    });
    const api = fakeApi({ emit });
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      loadOrder: { "other.esp": { loadOrder: 0, enabled: true } },
      session: { plugins: { pluginList: {} } },
    });

    const result = await getPluginDetails(api, ["missing.esp"]);

    expect(result).toEqual([
      {
        plugin: "missing.esp",
        index: -1,
        enabled: false,
        modId: undefined,
        deployed: undefined,
        isNative: undefined,
        group: undefined,
        version: undefined,
        messages: undefined,
        dirty: false,
      },
    ]);
  });
});

describe("vortexControl: listCategories", () => {
  it("sorts by order and joins mod counts per category", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        categories: {
          skyrimse: {
            "20": { name: "Skyrim Special Edition", order: 1 },
            "22": { name: "Buildings", order: 2, parentCategory: "20" },
          },
        },
        mods: {
          skyrimse: {
            modA: { id: "modA", type: "", installationPath: "", attributes: { category: "22" } },
            modB: { id: "modB", type: "", installationPath: "", attributes: { category: "22" } },
            modC: { id: "modC", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listCategories(api)).toEqual([
      {
        id: "20",
        name: "Skyrim Special Edition",
        order: 1,
        parentCategory: undefined,
        modCount: 0,
      },
      { id: "22", name: "Buildings", order: 2, parentCategory: "20", modCount: 2 },
    ]);
  });

  it("throws when there is no active game and none was provided", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("");

    expect(() => listCategories(fakeApi())).toThrow(/No active game/);
  });

  it("returns an empty list when the game has no categories", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { categories: {}, mods: {} },
    });

    expect(listCategories(api)).toEqual([]);
  });
});

describe("vortexControl: games", () => {
  // The launch-fallback tests below override knownGames. Restore the module
  // mock's default afterwards, or the override leaks into unrelated suites —
  // it silently broke listRuntimeErrors, which just wants fallout4 to exist.
  afterEach(() => {
    vi.mocked(selectors.knownGames).mockImplementation(
      () => [{ id: "skyrimse" }, { id: "skyrimvr" }, { id: "fallout4" }] as never,
    );
  });

  it("launchGame resolves the primary tool via settings.interface/gameMode.discovered and runs it", async () => {
    // The tool has to exist on disk: launchGame skips one whose path is gone,
    // so a made-up path here would exercise the fallback instead.
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-tool-"));
    const toolPath = path.join(toolRoot, "skse64_loader.exe");
    await writeFile(toolPath, "");

    try {
      vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
      const api = fakeApi();
      (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
        settings: {
          interface: { primaryTool: { skyrimse: "skse64" } },
          gameMode: { discovered: { skyrimse: { tools: { skse64: { path: toolPath } } } } },
        },
      });
      const runExecutable = vi.fn(async () => undefined);
      (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

      await launchGame(api);

      expect(runExecutable).toHaveBeenCalledWith(toolPath, [], {
        cwd: undefined,
        shell: false,
        detach: true,
        suggestDeploy: true,
      });
    } finally {
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it("launchGame falls back to the game's own executable when no primary tool is set", async () => {
    // The overwhelmingly common case — a freshly-managed game has no primary
    // tool — and it used to throw, making "launch the game" unusable for
    // exactly the profiles this harness creates.
    vi.mocked(selectors.knownGames).mockReturnValue([
      { id: "skyrimse", executable: "SkyrimSE.exe" },
    ] as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: {
        interface: { primaryTool: {} },
        gameMode: { discovered: { skyrimse: { path: "C:/Games/SkyrimSE" } } },
      },
    });
    const runExecutable = vi.fn(async () => undefined);
    (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

    await launchGame(api, "skyrimse");

    expect(runExecutable).toHaveBeenCalledWith(
      expect.stringContaining("SkyrimSE.exe"),
      [],
      expect.objectContaining({ suggestDeploy: true }),
    );
  });

  it("launchGame treats a cleared primary tool as no primary tool", async () => {
    // Clearing one leaves `null` behind rather than removing the key, so an
    // `!== undefined` check read it as a tool literally named "null" and
    // refused to launch at all — when clearing it is precisely how you ask for
    // the game's own executable. Seen with a seeded profile whose recorded tool
    // pointed at a path that no longer existed.
    vi.mocked(selectors.knownGames).mockReturnValue([
      { id: "skyrimse", executable: "SkyrimSE.exe" },
    ] as never);
    for (const cleared of [null, ""]) {
      const api = fakeApi();
      (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
        settings: {
          interface: { primaryTool: { skyrimse: cleared } },
          gameMode: { discovered: { skyrimse: { path: "C:/Games/SkyrimSE" } } },
        },
      });
      const runExecutable = vi.fn(async () => undefined);
      (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

      await launchGame(api, "skyrimse");

      expect(runExecutable).toHaveBeenCalledWith(
        expect.stringContaining("SkyrimSE.exe"),
        [],
        expect.objectContaining({ suggestDeploy: true }),
      );
    }
  });

  it("launchGame falls back when the primary tool starts nothing", async () => {
    // A stale loader — an F4SE built for another game version, say — exists on
    // disk and spawns cleanly, then exits having started nothing. That is
    // indistinguishable from a loader that handed off correctly, because both
    // leave no tool process behind, so the game itself is what gets watched.
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-tool-"));
    const toolPath = path.join(toolRoot, "loader.exe");
    await writeFile(toolPath, "");

    try {
      vi.mocked(selectors.knownGames).mockReturnValue([
        { id: "skyrimse", executable: "DefinitelyNotRunning.exe" },
      ] as never);
      const api = fakeApi();
      (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
        settings: {
          interface: { primaryTool: { skyrimse: "skse" } },
          gameMode: {
            discovered: {
              skyrimse: { path: "C:/Games/SkyrimSE", tools: { skse: { path: toolPath } } },
            },
          },
        },
      });
      const runExecutable = vi.fn(async (..._args: unknown[]) => undefined);
      (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

      const launched = await launchGame(api, "skyrimse", { processWaitMs: 0 });

      // The tool first, then the game itself once nothing showed up.
      expect(runExecutable).toHaveBeenCalledTimes(2);
      expect(runExecutable.mock.calls[0]?.[0]).toBe(toolPath);
      expect(String(runExecutable.mock.calls[1]?.[0])).toContain("DefinitelyNotRunning.exe");
      expect(launched).toContain("DefinitelyNotRunning.exe");
    } finally {
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it("launchGame ignores a primary tool whose executable no longer exists", async () => {
    // Profiles carry their recorded tools, so a seeded or restored instance
    // routinely names a path that is gone. Vortex spawns it anyway, the process
    // dies immediately, and the launch looks like it worked — so an unusable
    // tool is worse than no tool at all.
    vi.mocked(selectors.knownGames).mockReturnValue([
      { id: "skyrimse", executable: "SkyrimSE.exe" },
    ] as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: {
        interface: { primaryTool: { skyrimse: "skse" } },
        gameMode: {
          discovered: {
            skyrimse: {
              path: "C:/Games/SkyrimSE",
              tools: { skse: { path: "C:/Games/SkyrimSE/_old_backup/skse_loader.exe" } },
            },
          },
        },
      },
    });
    const runExecutable = vi.fn(async () => undefined);
    (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

    const launched = await launchGame(api, "skyrimse");

    expect(runExecutable).toHaveBeenCalledTimes(1);
    expect(runExecutable).toHaveBeenCalledWith(
      expect.stringContaining("SkyrimSE.exe"),
      [],
      expect.objectContaining({ suggestDeploy: true }),
    );
    expect(launched).toContain("SkyrimSE.exe");
  });

  it("launchGame prefers the executable discovery recorded over the extension's", async () => {
    // Someone who renamed or relocated the binary is recorded in discovery and
    // nowhere else, so that has to win.
    vi.mocked(selectors.knownGames).mockReturnValue([
      { id: "skyrimse", executable: "SkyrimSE.exe" },
    ] as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: {
        interface: { primaryTool: {} },
        gameMode: {
          discovered: { skyrimse: { path: "C:/Games/SkyrimSE", executable: "skse64_loader.exe" } },
        },
      },
    });
    const runExecutable = vi.fn(async () => undefined);
    (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

    await launchGame(api, "skyrimse");

    expect(runExecutable).toHaveBeenCalledWith(
      expect.stringContaining("skse64_loader.exe"),
      [],
      expect.anything(),
    );
  });

  it("launchGame falls back to requiredFiles when the extension declares no executable", async () => {
    vi.mocked(selectors.knownGames).mockReturnValue([
      { id: "skyrimse", requiredFiles: ["SkyrimSE.exe"] },
    ] as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: {
        interface: { primaryTool: {} },
        gameMode: { discovered: { skyrimse: { path: "C:/Games/SkyrimSE" } } },
      },
    });
    const runExecutable = vi.fn(async () => undefined);
    (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

    await launchGame(api, "skyrimse");

    expect(runExecutable).toHaveBeenCalledWith(
      expect.stringContaining("SkyrimSE.exe"),
      [],
      expect.anything(),
    );
  });

  it("launchGame throws when there is neither a primary tool nor a discovered path", async () => {
    vi.mocked(selectors.knownGames).mockReturnValue([{ id: "skyrimse" }] as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { interface: { primaryTool: {} }, gameMode: { discovered: {} } },
    });

    await expect(launchGame(api, "skyrimse")).rejects.toThrow(/no discovered install path/);
  });

  it("launchGame throws when the configured primary tool isn't in discovered tools", async () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: {
        interface: { primaryTool: { skyrimse: "skse64" } },
        gameMode: { discovered: { skyrimse: { tools: {} } } },
      },
    });

    await expect(launchGame(api, "skyrimse")).rejects.toThrow(/not in discovered tools/);
  });

  it("launchGame rejects when expectedActiveGameId no longer matches, without touching runExecutable", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("someOtherGame");
    const api = fakeApi();
    const runExecutable = vi.fn(async () => undefined);
    (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

    await expect(launchGame(api, "skyrimse", { activeGameId: "expectedGame" })).rejects.toThrow(
      /Active game changed/,
    );
    expect(runExecutable).not.toHaveBeenCalled();
  });
});

describe("vortexControl: restart", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("restartVortex calls window.api.app.relaunch", () => {
    const relaunch = vi.fn();
    (globalThis as { window?: unknown }).window = { api: { app: { relaunch } } };

    restartVortex();

    expect(relaunch).toHaveBeenCalled();
  });

  it("restartVortex throws when the preload bridge is unavailable", () => {
    (globalThis as { window?: unknown }).window = {};

    expect(() => restartVortex()).toThrow(/window.api.app.relaunch/);
  });
});

async function writeExtensionBundle(
  root: string,
  extensionName: string,
  text: string,
  entryFile: "index.cjs" | "index.js" = "index.cjs",
): Promise<void> {
  const dir = path.join(root, extensionName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, entryFile), text);
}

describe("vortexControl: scanExtensionActions", () => {
  let bundledRoot: string;
  let userDataRoot: string;

  beforeEach(async () => {
    bundledRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-bundled-"));
    userDataRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-userdata-"));
    vi.mocked(util.getVortexPath).mockImplementation((id: string) => {
      if (id === "bundledPlugins") return bundledRoot;
      if (id === "userData") return userDataRoot;
      return "";
    });
  });

  afterEach(async () => {
    await rm(bundledRoot, { recursive: true, force: true });
    await rm(userDataRoot, { recursive: true, force: true });
  });

  it("recovers type and payload key->argIndex shape from a real minified createAction call site", async () => {
    // The exact byte sequence confirmed live in gamebryo-plugin-management/index.cjs.
    await writeExtensionBundle(
      bundledRoot,
      "gamebryo-plugin-management",
      "const N=(0,g.createAction)(`SET_PLUGIN_ENABLED`,(e,t)=>({pluginName:e,enabled:t}));",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result).toEqual([
      {
        type: "SET_PLUGIN_ENABLED",
        extension: "gamebryo-plugin-management",
        payloadKeys: { pluginName: 0, enabled: 1 },
        passthroughPayload: false,
        noPayload: false,
      },
    ]);
  });

  it("recognizes a passthrough (bare-identifier) creator as payload=args[0]", async () => {
    await writeExtensionBundle(
      bundledRoot,
      "some-ext",
      "x=(0,g.createAction)(`CLEAR_USERLIST`,e=>e);",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result).toEqual([
      {
        type: "CLEAR_USERLIST",
        extension: "some-ext",
        payloadKeys: {},
        passthroughPayload: true,
        noPayload: false,
      },
    ]);
  });

  it("still reports the type string when the prepare-fn shape isn't recognized", async () => {
    await writeExtensionBundle(
      bundledRoot,
      "weird-ext",
      "x=(0,g.createAction)(`SOME_TYPE`,(a,b,c)=>doSomethingComplicated(a,b,c));",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result).toEqual([
      {
        type: "SOME_TYPE",
        extension: "weird-ext",
        payloadKeys: {},
        passthroughPayload: false,
        noPayload: false,
      },
    ]);
  });

  it("recovers the object-literal shape from a null-guarded ternary prepare-fn", async () => {
    // The exact byte sequence confirmed live in mod-dependency-manager/index.cjs
    // (SET_EDIT_MOD_CYCLE) -- the only one of 85 real actions this project's scanner
    // couldn't classify before this test was added.
    await writeExtensionBundle(
      bundledRoot,
      "mod-dependency-manager",
      "x=(0,_.createAction)(`SET_EDIT_MOD_CYCLE`,(e,t)=>e===void 0?void 0:{gameId:e,modIds:t});",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result).toEqual([
      {
        type: "SET_EDIT_MOD_CYCLE",
        extension: "mod-dependency-manager",
        payloadKeys: { gameId: 0, modIds: 1 },
        passthroughPayload: false,
        noPayload: false,
      },
    ]);
  });

  it("recognizes a no-argument creator (createAction(TYPE) with no second arg) as a CONFIRMED no-payload shape, not an unrecognized one", async () => {
    // Found live: 3 of gamebryo-plugin-management's 26 actions use this form
    // (CLEAR_USERLIST, CLOSE_PLUGIN_RULE_DIALOG, CLEAR_NEW_PLUGIN_COUNTER).
    await writeExtensionBundle(
      bundledRoot,
      "some-ext",
      "x=(0,g.createAction)(`CLOSE_PLUGIN_RULE_DIALOG`);",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result).toEqual([
      {
        type: "CLOSE_PLUGIN_RULE_DIALOG",
        extension: "some-ext",
        payloadKeys: {},
        passthroughPayload: false,
        noPayload: true,
      },
    ]);
  });

  it("finds multiple createAction sites in one file and dedupes repeated types", async () => {
    await writeExtensionBundle(
      bundledRoot,
      "multi-ext",
      "a=(0,g.createAction)(`TYPE_ONE`,e=>e),b=(0,g.createAction)(`TYPE_TWO`,(e,t)=>({x:e,y:t})),c=(0,g.createAction)(`TYPE_ONE`,e=>e);",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result.map((r) => r.type)).toEqual(["TYPE_ONE", "TYPE_TWO"]);
  });

  it("scans both the bundled and user-installed plugin roots", async () => {
    await writeExtensionBundle(
      bundledRoot,
      "builtin-ext",
      "(0,g.createAction)(`BUILTIN_TYPE`,e=>e);",
    );
    await writeExtensionBundle(
      path.join(userDataRoot, "plugins"),
      "vortex-mcp",
      "(0,g.createAction)(`USER_TYPE`,e=>e);",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result.map((r) => r.type).toSorted()).toEqual(["BUILTIN_TYPE", "USER_TYPE"]);
  });

  it("skips an extension directory with neither index.cjs nor index.js rather than throwing", async () => {
    await mkdir(path.join(bundledRoot, "no-bundle-here"), { recursive: true });
    await writeExtensionBundle(bundledRoot, "real-ext", "(0,g.createAction)(`REAL_TYPE`,e=>e);");

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result.map((r) => r.type)).toEqual(["REAL_TYPE"]);
  });

  it("falls back to index.js when index.cjs doesn't exist", async () => {
    // Found live: entry filename isn't uniform -- 70 of 132 bundled extensions on a
    // real install ship index.js instead of index.cjs, and EVERY user-installed/
    // third-party extension on that same install used index.js exclusively (a real
    // Starfield extension had 6 createAction sites this project was silently missing
    // before this fallback was added).
    await writeExtensionBundle(
      bundledRoot,
      "js-only-ext",
      "(0,g.createAction)(`JS_ENTRY_TYPE`,e=>e);",
      "index.js",
    );

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result.map((r) => r.type)).toEqual(["JS_ENTRY_TYPE"]);
  });

  it("prefers index.cjs over index.js when both exist in the same extension directory", async () => {
    const dir = path.join(bundledRoot, "both-ext");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.cjs"), "(0,g.createAction)(`FROM_CJS`,e=>e);");
    await writeFile(path.join(dir, "index.js"), "(0,g.createAction)(`FROM_JS`,e=>e);");

    const result = await scanExtensionActions(fakeApi(), true);

    expect(result.map((r) => r.type)).toEqual(["FROM_CJS"]);
  });

  it("caches results across calls until forceRefresh is passed", async () => {
    await writeExtensionBundle(bundledRoot, "ext-a", "(0,g.createAction)(`FIRST_SCAN_TYPE`,e=>e);");
    const first = await scanExtensionActions(fakeApi(), true);
    expect(first.map((r) => r.type)).toEqual(["FIRST_SCAN_TYPE"]);

    await writeExtensionBundle(
      bundledRoot,
      "ext-b",
      "(0,g.createAction)(`SECOND_SCAN_TYPE`,e=>e);",
    );
    const cached = await scanExtensionActions(fakeApi(), false);
    expect(cached.map((r) => r.type)).toEqual(["FIRST_SCAN_TYPE"]);

    const refreshed = await scanExtensionActions(fakeApi(), true);
    expect(refreshed.map((r) => r.type).toSorted()).toEqual([
      "FIRST_SCAN_TYPE",
      "SECOND_SCAN_TYPE",
    ]);
  });
});

describe("vortexControl: dispatchAction", () => {
  it("dispatches a raw {type, payload} action when given a 'type:' prefix, bypassing the action-creator lookup entirely", async () => {
    const dispatch = vi.fn();

    const result = await dispatchAction(fakeApi({ dispatch }), "type:SET_PLUGIN_ENABLED", [
      { pluginName: "Foo.esp", enabled: false },
    ]);

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_PLUGIN_ENABLED",
      payload: { pluginName: "Foo.esp", enabled: false },
    });
    expect(result).toEqual({ dispatched: "SET_PLUGIN_ENABLED", raw: true });
  });

  it("dispatches a named action and returns it", async () => {
    const dispatch = vi.fn();

    const result = await dispatchAction(fakeApi({ dispatch }), "setLoadOrder", [["modA", "modB"]]);

    expect(actions.setLoadOrder).toHaveBeenCalledWith(["modA", "modB"]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_LOAD_ORDER",
      payload: ["modA", "modB"],
    });
    expect(result).toEqual({ type: "SET_LOAD_ORDER", payload: ["modA", "modB"] });
  });

  it("dispatches any action, including ones that used to be allowlist-excluded — the token is the boundary, not this function", async () => {
    const dispatch = vi.fn();

    const result = await dispatchAction(fakeApi({ dispatch }), "setGamePath", ["C:\\Games"]);

    expect(actions.setGamePath).toHaveBeenCalledWith("C:\\Games");
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_GAME_PATH", payload: "C:\\Games" });
    expect(result).toEqual({ type: "SET_GAME_PATH", payload: "C:\\Games" });
  });

  it("falls back to a named api.ext function when the name isn't a Redux action", async () => {
    const nexusGetModInfo = vi.fn(async () => ({ name: "Cool Mod" }));
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = { nexusGetModInfo };

    const result = await dispatchAction(api, "nexusGetModInfo", ["skyrimse", 63979]);

    expect(nexusGetModInfo).toHaveBeenCalledWith("skyrimse", 63979);
    expect(result).toEqual({ name: "Cool Mod" });
  });

  it("falls back to firing a registered event when the name isn't an action or api.ext function", async () => {
    const emit = vi.fn();
    const api = fakeApi({ emit });
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    vi.mocked(
      (api as unknown as { events: { eventNames: () => string[] } }).events.eventNames,
    ).mockReturnValue(["activate-game"]);

    const result = await dispatchAction(api, "activate-game", ["skyrimse"]);

    expect(emit).toHaveBeenCalledWith("activate-game", "skyrimse");
    expect(result).toEqual({ emitted: "activate-game" });
  });

  it("awaits a callback-based event when __CALLBACK__ is in the args", async () => {
    const emit = vi.fn((event: string, cb: (err: Error | null) => void) => {
      expect(event).toBe("deploy-mods");
      cb(null);
    });
    const api = fakeApi({ emit });
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    vi.mocked(
      (api as unknown as { events: { eventNames: () => string[] } }).events.eventNames,
    ).mockReturnValue(["deploy-mods"]);

    await expect(dispatchAction(api, "deploy-mods", ["__CALLBACK__"])).resolves.toBeUndefined();
  });

  it("rejects a callback-based event whose callback reports an error", async () => {
    const emit = vi.fn((_event: string, cb: (err: Error | null) => void) => cb(new Error("boom")));
    const api = fakeApi({ emit });
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    vi.mocked(
      (api as unknown as { events: { eventNames: () => string[] } }).events.eventNames,
    ).mockReturnValue(["deploy-mods"]);

    await expect(dispatchAction(api, "deploy-mods", ["__CALLBACK__"])).rejects.toThrow("boom");
  });

  it("falls back to a direct method on the api object itself", async () => {
    const sendNotification = vi.fn(() => "notif-id");
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    (api as unknown as { sendNotification: unknown }).sendNotification = sendNotification;

    const result = await dispatchAction(api, "sendNotification", [{ message: "hi" }]);

    expect(sendNotification).toHaveBeenCalledWith({ message: "hi" });
    expect(result).toBe("notif-id");
  });

  it("rejects a name that's neither a known action, api.ext function, event, nor api method", async () => {
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {};

    await expect(dispatchAction(api, "totallyMadeUp")).rejects.toThrow(/Unknown action/);
  });

  it("registers a persistent listener for a known listener apiMethod and returns a listenerId", async () => {
    let capturedCallback: ((...args: unknown[]) => unknown) | undefined;
    const onStateChange = vi.fn((_path: string[], cb: (...args: unknown[]) => unknown) => {
      capturedCallback = cb;
    });
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    (api as unknown as { onStateChange: unknown }).onStateChange = onStateChange;

    const result = (await dispatchAction(api, "onStateChange", [
      ["settings", "interface", "advanced"],
      "__CALLBACK__",
    ])) as { listenerId: string };

    expect(onStateChange).toHaveBeenCalledWith(
      ["settings", "interface", "advanced"],
      expect.any(Function),
    );
    expect(result.listenerId).toEqual(expect.any(String));
    expect(pollListener(result.listenerId).entries).toEqual([]);

    capturedCallback?.(false, true);
    capturedCallback?.(true, false);

    const firstPoll = pollListener(result.listenerId);
    expect(firstPoll.entries.map((e) => e.args)).toEqual([
      [false, true],
      [true, false],
    ]);

    // Non-destructive: polling again with the same `since` returns the same entries.
    expect(pollListener(result.listenerId).entries).toEqual(firstPoll.entries);

    // Passing back lastSeq only returns what arrived after it.
    capturedCallback?.("third");
    const secondPoll = pollListener(result.listenerId, firstPoll.lastSeq);
    expect(secondPoll.entries.map((e) => e.args)).toEqual([["third"]]);
  });

  it("onEvent subscribes to a plain event once, with JSON-safe args", async () => {
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    const on = (api as unknown as { events: { on: ReturnType<typeof vi.fn> } }).events.on;

    const first = (await dispatchAction(api, "onEvent", [
      "collection-postprocess-complete",
      "__CALLBACK__",
    ])) as { listenerId: string };
    const again = (await dispatchAction(api, "onEvent", [
      "collection-postprocess-complete",
      "__CALLBACK__",
    ])) as { listenerId: string };

    expect(again.listenerId).toBe(first.listenerId);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("collection-postprocess-complete", expect.any(Function));

    const handler = on.mock.calls[0]?.[1] as (...args: unknown[]) => void;
    const cyclic: Record<string, unknown> = { id: "m1", cb: () => undefined };
    cyclic.self = cyclic;
    handler("fallout4", cyclic);
    expect(pollListener(first.listenerId).entries.map((e) => e.args)).toEqual([
      ["fallout4", { id: "m1", self: "[circular]" }],
    ]);
    await expect(dispatchAction(api, "onEvent", ["__CALLBACK__"])).rejects.toThrow(
      /needs the event name/,
    );
  });

  it("throws a clear error when a listener apiMethod is dispatched without the __CALLBACK__ sentinel", async () => {
    const onStateChange = vi.fn();
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    (api as unknown as { onStateChange: unknown }).onStateChange = onStateChange;

    await expect(dispatchAction(api, "onStateChange", [["settings"]])).rejects.toThrow(
      /needs the "__CALLBACK__" sentinel/,
    );
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("rejects dispatching withPrePost since its return value isn't usefully expressible over MCP", async () => {
    const withPrePost = vi.fn();
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {};
    (api as unknown as { withPrePost: unknown }).withPrePost = withPrePost;

    await expect(dispatchAction(api, "withPrePost", ["did-deploy"])).rejects.toThrow(
      /can't be usefully dispatched/,
    );
    expect(withPrePost).not.toHaveBeenCalled();
  });

  it("pollListener throws for an unknown listenerId", () => {
    expect(() => pollListener("not-a-real-id")).toThrow(/Unknown listenerId/);
  });

  it("dispatches removeProfile like any other action", async () => {
    const dispatch = vi.fn();

    const result = await dispatchAction(fakeApi({ dispatch }), "removeProfile", ["clone-id"]);

    expect(actions.removeProfile).toHaveBeenCalledWith("clone-id");
    expect(result).toEqual({ type: "REMOVE_PROFILE", payload: "clone-id" });
  });

  it("dispatches a thunk-returning action (closeDialog) directly, not as a {type} object", async () => {
    const dispatch = vi.fn();

    const result = await dispatchAction(fakeApi({ dispatch }), "closeDialog", ["d1", "Ignore"]);

    expect(actions.closeDialog).toHaveBeenCalledWith("d1", "Ignore");
    // The thunk itself was handed to dispatch (redux-thunk middleware's job to run it) —
    // simulate that here to confirm it's the real thunk, not something pre-invoked.
    expect(dispatch).toHaveBeenCalledWith(expect.any(Function));
    const thunk = dispatch.mock.calls[0][0] as (fn: (a: unknown) => void) => void;
    const innerDispatch = vi.fn();
    thunk(innerDispatch);
    expect(innerDispatch).toHaveBeenCalledWith({
      type: "CLOSE_DIALOG_THUNK_RAN",
      id: "d1",
      actionKey: "Ignore",
    });
    expect(result).toEqual({ dispatched: "closeDialog", thunk: true });
  });

  it("rejects when expectedActiveProfileId no longer matches, without dispatching anything", async () => {
    vi.mocked(selectors.activeProfileId).mockReturnValue("someOtherProfile");
    const dispatch = vi.fn();

    await expect(
      dispatchAction(fakeApi({ dispatch }), "setLoadOrder", [["modA"]], {
        activeProfileId: "expectedProfile",
      }),
    ).rejects.toThrow(/Active profile changed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects when expectedActiveGameId no longer matches, without dispatching anything", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("someOtherGame");
    const dispatch = vi.fn();

    await expect(
      dispatchAction(fakeApi({ dispatch }), "setLoadOrder", [["modA"]], {
        activeGameId: "expectedGame",
      }),
    ).rejects.toThrow(/Active game changed/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("vortexControl: backupState", () => {
  it("writes a snapshot of settings/persistent/app/user state to Vortex's backup folder", async () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { s: 1 },
      persistent: { p: 1 },
      app: { a: 1 },
      user: { u: 1 },
      session: { secret: "never backed up" },
    });

    const backupPath = await backupState(api, "test");

    expect(backupPath).toContain(path.join("temp", "state_backups_full"));
    expect(backupPath).toContain("test-");
    expect(fs.ensureDirWritableAsync).toHaveBeenCalled();
    const written = vi.mocked(util.writeFileAtomic).mock.calls[0];
    expect(written[0]).toBe(backupPath);
    const parsed = JSON.parse(written[1] as string);
    expect(parsed).toEqual({
      settings: { s: 1 },
      persistent: { p: 1 },
      app: { a: 1 },
      user: { u: 1 },
    });
  });
});

describe("vortexControl: listDownloads", () => {
  it("filters downloads by game and computes progress percent", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            d1: {
              id: "d1",
              game: ["skyrimse"],
              state: "paused",
              size: 200,
              received: 200,
              startTime: 100,
              modInfo: { name: "Cool Mod" },
            },
            d2: {
              id: "d2",
              game: ["fallout4"],
              state: "paused",
              size: 100,
              received: 100,
              startTime: 200,
            },
            d3: {
              id: "d3",
              game: ["skyrimse"],
              state: "downloading",
              size: 400,
              received: 100,
              startTime: 50,
              localPath: "mod3.zip",
            },
          },
        },
      },
    });

    expect(listDownloads(api)).toEqual([
      { id: "d1", name: "Cool Mod", state: "paused", progress: 100, size: 200, startTime: 100 },
      {
        id: "d3",
        name: "mod3.zip",
        state: "downloading",
        progress: 25,
        size: 400,
        startTime: 50,
      },
    ]);
  });

  it("throws when there is no active game and none was provided", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("");

    expect(() => listDownloads(fakeApi())).toThrow(/No active game/);
  });

  it("treats a missing `received` as 0 progress instead of NaN (seen live on some entries)", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            d1: {
              id: "d1",
              game: ["skyrimse"],
              state: "started",
              size: 200,
              startTime: 0,
              localPath: "mod1.zip",
            },
          },
        },
      },
    });

    expect(listDownloads(api)).toEqual([
      { id: "d1", name: "mod1.zip", state: "started", progress: 0, size: 200, startTime: 0 },
    ]);
  });

  it("excludes 'finished' downloads by default (a real history can run hundreds deep)", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            done: { id: "done", game: ["skyrimse"], state: "finished", size: 1, startTime: 1 },
            failed: { id: "failed", game: ["skyrimse"], state: "failed", size: 1, startTime: 2 },
          },
        },
      },
    });

    expect(listDownloads(api).map((d) => d.id)).toEqual(["failed"]);
  });

  it("includes 'finished' when explicitly requested via states", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            done: { id: "done", game: ["skyrimse"], state: "finished", size: 1, startTime: 1 },
            failed: { id: "failed", game: ["skyrimse"], state: "failed", size: 1, startTime: 2 },
          },
        },
      },
    });

    expect(listDownloads(api, undefined, { states: ["finished"] }).map((d) => d.id)).toEqual([
      "done",
    ]);
  });

  it("sorts most-recently-started first and applies limit", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            a: { id: "a", game: ["skyrimse"], state: "paused", size: 1, startTime: 10 },
            b: { id: "b", game: ["skyrimse"], state: "paused", size: 1, startTime: 30 },
            c: { id: "c", game: ["skyrimse"], state: "paused", size: 1, startTime: 20 },
          },
        },
      },
    });

    expect(listDownloads(api, undefined, { limit: 2 }).map((d) => d.id)).toEqual(["b", "c"]);
  });

  it("falls back to the Redux map key for id when the record's own id field is undefined (seen live on 'failed' downloads)", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            B1gem3HNfC: {
              game: ["skyrimse"],
              state: "failed",
              size: 1,
              startTime: 1,
              modInfo: { name: "Some Mod" },
            },
          },
        },
      },
    });

    expect(listDownloads(api).map((d) => d.id)).toEqual(["B1gem3HNfC"]);
  });

  it("surfaces installedModId from download.installed.modId as the download-to-mod join key", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            d1: {
              id: "d1",
              game: ["skyrimse"],
              state: "paused",
              size: 1,
              startTime: 1,
              installed: { gameId: "skyrimse", modId: "Cool Mod-123" },
            },
            d2: { id: "d2", game: ["skyrimse"], state: "paused", size: 1, startTime: 2 },
          },
        },
      },
    });

    const result = listDownloads(api);
    expect(result.find((d) => d.id === "d1")?.installedModId).toBe("Cool Mod-123");
    expect(result.find((d) => d.id === "d2")?.installedModId).toBeUndefined();
  });
});

describe("vortexControl: listNotifications", () => {
  it("maps notifications to their summary fields", () => {
    vi.mocked(selectors.notifications).mockReturnValue([
      { id: "n1", type: "error", title: "Deployment failed", message: "Permission denied" },
      { type: "info", message: "No title here" },
    ]);

    expect(listNotifications(fakeApi())).toEqual([
      { id: "n1", type: "error", title: "Deployment failed", message: "Permission denied" },
      { id: undefined, type: "info", title: undefined, message: "No title here" },
    ]);
  });
});

describe("vortexControl: listDialogs", () => {
  it("flattens a dialog's content and surfaces the exact action labels to pick from", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      session: {
        notifications: {
          dialogs: [
            {
              id: "d1",
              type: "question",
              title: "Files changed",
              content: { message: "Some files changed outside Vortex." },
              actions: ["Ignore", "Keep changes"],
              defaultAction: "Ignore",
            },
          ],
        },
      },
    });

    expect(listDialogs(api)).toEqual([
      {
        id: "d1",
        type: "question",
        title: "Files changed",
        message: "Some files changed outside Vortex.",
        actions: ["Ignore", "Keep changes"],
        defaultAction: "Ignore",
        checkboxes: undefined,
        input: undefined,
      },
    ]);
  });

  it("returns an empty array when no dialog is open", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      session: { notifications: { dialogs: [] } },
    });

    expect(listDialogs(api)).toEqual([]);
  });
});

describe("vortexControl: listExternalChanges", () => {
  it("surfaces pending external changes from session.mods.changes", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      session: {
        mods: {
          changes: [
            {
              filePath: "SKSE\\Plugins\\EngineFixes.dll",
              source: "Engine Fixes VR-62089-7-1-1-1776053056",
              modTypeId: "",
              type: "refchange",
              action: "newest",
              sourceModified: "2026-08-29T20:45:53.950Z",
              destModified: "2026-09-01T09:16:14.605Z",
            },
          ],
        },
      },
    });

    expect(listExternalChanges(api)).toEqual([
      {
        filePath: "SKSE\\Plugins\\EngineFixes.dll",
        source: "Engine Fixes VR-62089-7-1-1-1776053056",
        modTypeId: "",
        type: "refchange",
        action: "newest",
        sourceModified: "2026-08-29T20:45:53.950Z",
        destModified: "2026-09-01T09:16:14.605Z",
      },
    ]);
  });

  it("returns an empty array when nothing is pending", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      session: { mods: {} },
    });

    expect(listExternalChanges(api)).toEqual([]);
  });
});

describe("vortexControl: listModRules", () => {
  it("resolves rule references to friendly names when the target mod is installed", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [
                { type: "after", reference: { id: "modB", versionMatch: "*" } },
                { type: "before", reference: { idHint: "unknown-mod" } },
              ],
            },
            modB: { id: "modB", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listModRules(api, "modA")).toEqual([
      { type: "after", targetId: "modB", targetName: "modB", versionMatch: "*" },
      { type: "before", targetId: "unknown-mod", targetName: undefined, versionMatch: undefined },
    ]);
  });

  it("throws for an unknown mod id", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: {} } },
    });

    expect(() => listModRules(api, "missing")).toThrow(/Unknown mod/);
  });

  it("surfaces logicalFileName/comment instead of a fake targetId for a rule with no id/idHint (seen live: a same-file-version-guard 'conflicts' rule)", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [
                {
                  type: "conflicts",
                  comment: "Incompatible Script Extender",
                  reference: {
                    logicalFileName: "Skyrim Script Extender VR (SKSEVR)",
                    versionMatch: "<2.0.12 || >2.0.12",
                  },
                },
              ],
            },
          },
        },
      },
    });

    expect(listModRules(api, "modA")).toEqual([
      {
        type: "conflicts",
        targetId: undefined,
        targetName: undefined,
        logicalFileName: "Skyrim Script Extender VR (SKSEVR)",
        versionMatch: "<2.0.12 || >2.0.12",
        comment: "Incompatible Script Extender",
      },
    ]);
  });
});

describe("vortexControl: findModDependents", () => {
  it("finds every OTHER mod whose rules reference the target, ignoring its own rules", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modB: { enabled: true }, modC: { enabled: false } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              // modA's own rules must never appear in modA's own dependents.
              rules: [{ type: "before", reference: { id: "modA" } }],
            },
            modB: {
              id: "modB",
              type: "",
              installationPath: "",
              rules: [{ type: "after", reference: { id: "modA", versionMatch: "*" } }],
            },
            modC: {
              id: "modC",
              type: "",
              installationPath: "",
              rules: [{ type: "requires", reference: { idHint: "modA" } }],
            },
            modD: {
              id: "modD",
              type: "",
              installationPath: "",
              rules: [{ type: "after", reference: { id: "modB" } }],
            },
          },
        },
      },
    });

    expect(findModDependents(api, "modA")).toEqual([
      { modId: "modB", modName: "modB", ruleType: "after", enabled: true, versionMatch: "*" },
      { modId: "modC", modName: "modC", ruleType: "requires", enabled: false },
    ]);
  });

  it("returns an empty array for a mod nothing depends on", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: { modA: { id: "modA", type: "", installationPath: "" } } } },
    });

    expect(findModDependents(api, "modA")).toEqual([]);
  });

  it("throws for an unknown mod id", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: {} } },
    });

    expect(() => findModDependents(api, "missing")).toThrow(/Unknown mod/);
  });
});

describe("vortexControl: findModByFile / listFileConflicts", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeModFile(modFolder: string, relPath: string): Promise<void> {
    const full = path.join(tempRoot, modFolder, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "x");
  }

  function apiWithMods(
    mods: Record<string, unknown>,
    modState: Record<string, { enabled: boolean }>,
  ) {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({ gameId: "skyrimse", modState } as never);
    vi.mocked(selectors.installPathForGame).mockReturnValue(tempRoot);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: mods } },
    });
    return api;
  }

  it("findModByFile matches by basename across enabled mods only, by default", async () => {
    await writeModFile("ModA", path.join("meshes", "foo.nif"));
    await writeModFile("ModB", "unrelated.txt");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: false } },
    );

    expect(await findModByFile(api, "foo.nif")).toEqual([
      {
        modId: "modA",
        modName: "modA",
        relativePath: path.join("meshes", "foo.nif"),
        enabled: true,
      },
    ]);
  });

  it("findModByFile with includeDisabled also searches disabled mods", async () => {
    await writeModFile("ModC", "foo.nif");
    const api = apiWithMods(
      { modC: { id: "modC", installationPath: "ModC" } },
      { modC: { enabled: false } },
    );

    expect(await findModByFile(api, "foo.nif")).toEqual([]);
    expect(await findModByFile(api, "foo.nif", { includeDisabled: true })).toEqual([
      { modId: "modC", modName: "modC", relativePath: "foo.nif", enabled: false },
    ]);
  });

  it("listFileConflicts reports files provided by more than one enabled mod, not unique ones", async () => {
    await writeModFile("ModA", path.join("scripts", "shared.pex"));
    await writeModFile("ModB", path.join("scripts", "shared.pex"));
    await writeModFile("ModB", "onlyInB.txt");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    const conflicts = await listFileConflicts(api);

    expect(conflicts).toEqual([
      {
        file: path.join("scripts", "shared.pex").toLowerCase(),
        mods: expect.arrayContaining([
          { id: "modA", name: "modA" },
          { id: "modB", name: "modB" },
        ]),
        risk: "high",
      },
    ]);
  });

  it("listFileConflicts classifies risk by file type without picking a winner", async () => {
    await writeModFile("ModA", "plugin.esp");
    await writeModFile("ModB", "plugin.esp");
    await writeModFile("ModA", "settings.ini");
    await writeModFile("ModB", "settings.ini");
    await writeModFile("ModA", "texture.dds");
    await writeModFile("ModB", "texture.dds");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    const conflicts = await listFileConflicts(api);
    const riskByFile = Object.fromEntries(conflicts.map((c) => [c.file, c.risk]));

    expect(riskByFile).toEqual({
      "plugin.esp": "high",
      "settings.ini": "medium",
      "texture.dds": "low",
    });
  });

  it("listFileConflicts ignores a disabled mod's files entirely", async () => {
    await writeModFile("ModA", "shared.esp");
    await writeModFile("ModB", "shared.esp");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: false } },
    );

    expect(await listFileConflicts(api)).toEqual([]);
  });
});

function buildTES4Buffer(masters: string[]): Buffer {
  const subrecords = masters.map((master) => {
    const nameBuf = Buffer.from(`${master}\0`, "ascii");
    const sizeBuf = Buffer.alloc(2);
    sizeBuf.writeUInt16LE(nameBuf.length, 0);
    return Buffer.concat([Buffer.from("MAST", "ascii"), sizeBuf, nameBuf]);
  });
  const data = Buffer.concat(subrecords);
  const header = Buffer.alloc(24);
  header.write("TES4", 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe("vortexControl: findMissingMasters", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-plugins-"));
    await mkdir(path.join(tempRoot, "Data"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writePlugin(name: string, masters: string[]): Promise<void> {
    await writeFile(path.join(tempRoot, "Data", name), buildTES4Buffer(masters));
  }

  function apiWithLoadOrder(loadOrder: Record<string, { loadOrder: number; enabled: boolean }>) {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { gameMode: { discovered: { skyrimse: { path: tempRoot } } } },
      loadOrder,
    });
    return api;
  }

  it("finds a plugin whose master isn't enabled, by reading its real TES4 header", async () => {
    await writePlugin("Skyrim.esm", []);
    await writePlugin("Patch.esp", ["Skyrim.esm", "MissingMod.esm"]);
    const api = apiWithLoadOrder({
      "Skyrim.esm": { loadOrder: 0, enabled: true },
      "Patch.esp": { loadOrder: 1, enabled: true },
    });

    expect(await findMissingMasters(api)).toEqual([
      { plugin: "Patch.esp", missingMasters: ["MissingMod.esm"] },
    ]);
  });

  it("returns nothing when every master is enabled", async () => {
    await writePlugin("Skyrim.esm", []);
    await writePlugin("Patch.esp", ["Skyrim.esm"]);
    const api = apiWithLoadOrder({
      "Skyrim.esm": { loadOrder: 0, enabled: true },
      "Patch.esp": { loadOrder: 1, enabled: true },
    });

    expect(await findMissingMasters(api)).toEqual([]);
  });

  it("throws when the game isn't discovered", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { gameMode: { discovered: {} } },
      loadOrder: {},
    });

    await expect(findMissingMasters(api)).rejects.toThrow(/not discovered/);
  });
});

describe("vortexControl: listRuntimeErrors", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-docs-"));
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(util.getVortexPath).mockReturnValue(tempRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reads Papyrus error lines and extracts mentioned mod files", async () => {
    const papyrusDir = path.join(tempRoot, "My Games", "Skyrim Special Edition", "Logs", "Script");
    await mkdir(papyrusDir, { recursive: true });
    await writeFile(
      path.join(papyrusDir, "Papyrus.0.log"),
      [
        "[08/31/2026 - 20:50:04PM] Papyrus log opened",
        "[08/31/2026 - 20:50:10PM] error: Cannot call GetActorValue() on a None object, aka SomeMod.esp",
        "[08/31/2026 - 20:50:15PM] all good here",
      ].join("\r\n"),
    );

    const entries = await listRuntimeErrors(fakeApi());

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("papyrus");
    expect(entries[0]?.excerpt).toContain("Cannot call GetActorValue");
    expect(entries[0]?.mentionedFiles).toEqual(["SomeMod.esp"]);
  });

  it("returns the newest crash logs first, capped by maxCrashLogs", async () => {
    const skseDir = path.join(tempRoot, "My Games", "Skyrim Special Edition", "SKSE");
    await mkdir(skseDir, { recursive: true });
    await writeFile(path.join(skseDir, "crash-2026-01-01-00-00-00.log"), "old crash\nline2");
    await writeFile(path.join(skseDir, "crash-2026-06-01-00-00-00.log"), "newer crash\nline2");
    // Make the mtimes unambiguous regardless of write speed.
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-06-01T00:00:00Z");
    await Promise.all([
      utimes(path.join(skseDir, "crash-2026-01-01-00-00-00.log"), old, old),
      utimes(path.join(skseDir, "crash-2026-06-01-00-00-00.log"), newer, newer),
    ]);

    const entries = await listRuntimeErrors(fakeApi(), { maxCrashLogs: 1 });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("crash");
    expect(entries[0]?.excerpt).toContain("newer crash");
  });

  it("returns an empty array when no logs exist yet, without throwing", async () => {
    expect(await listRuntimeErrors(fakeApi())).toEqual([]);
  });

  it("throws a clear error for a real, known game with no verified save-data folder", async () => {
    // "fallout4" is in the knownGames mock (so it clears resolveGameId's validation) but
    // deliberately absent from MY_GAMES_FOLDER, exercising that check specifically rather
    // than the earlier "is this gameId even real" one.
    await expect(listRuntimeErrors(fakeApi(), { gameId: "fallout4" })).rejects.toThrow(
      /Don't know the save-data folder/,
    );
  });

  it("throws a clear error for a gameId Vortex has never heard of", async () => {
    await expect(listRuntimeErrors(fakeApi(), { gameId: "someUnknownGame" })).rejects.toThrow(
      /Unknown gameId/,
    );
  });
});

describe("vortexControl: listDuplicateMods", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-dup-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeModFile(modFolder: string, relPath: string): Promise<void> {
    const full = path.join(tempRoot, modFolder, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "x");
  }

  function apiWithMods(
    mods: Record<string, unknown>,
    modState: Record<string, { enabled: boolean }>,
  ) {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({ gameId: "skyrimse", modState } as never);
    vi.mocked(selectors.installPathForGame).mockReturnValue(tempRoot);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: mods } },
    });
    return api;
  }

  it("flags more than one installed mod sharing the same Nexus mod id", async () => {
    await writeModFile("ModA", "a.esp");
    await writeModFile("ModB", "b.esp");
    const api = apiWithMods(
      {
        modA: {
          id: "modA",
          installationPath: "ModA",
          attributes: { source: "nexus", modId: 12345 },
        },
        modB: {
          id: "modB",
          installationPath: "ModB",
          attributes: { source: "nexus", modId: 12345 },
        },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    const groups = await listDuplicateMods(api);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "same-nexus-id",
          mods: expect.arrayContaining([
            { id: "modA", name: "modA" },
            { id: "modB", name: "modB" },
          ]),
        }),
      ]),
    );
  });

  it("does not flag mods with different Nexus ids or non-Nexus sources", async () => {
    await writeModFile("ModA", "a.esp");
    await writeModFile("ModB", "b.esp");
    const api = apiWithMods(
      {
        modA: {
          id: "modA",
          installationPath: "ModA",
          attributes: { source: "nexus", modId: 111 },
        },
        modB: { id: "modB", installationPath: "ModB", attributes: { source: "manual" } },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    expect(await listDuplicateMods(api)).toEqual([]);
  });

  it("flags a mod whose entire file set is a subset of a larger mod's", async () => {
    await writeModFile("BigMod", "meshes/a.nif");
    await writeModFile("BigMod", "textures/a.dds");
    await writeModFile("BigMod", "plugin.esp");
    await writeModFile("OldVersion", "meshes/a.nif");
    const api = apiWithMods(
      {
        bigMod: { id: "bigMod", installationPath: "BigMod" },
        oldVersion: { id: "oldVersion", installationPath: "OldVersion" },
      },
      { bigMod: { enabled: true }, oldVersion: { enabled: true } },
    );

    const groups = await listDuplicateMods(api);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "file-subset",
          mods: [
            { id: "bigMod", name: "bigMod" },
            { id: "oldVersion", name: "oldVersion" },
          ],
        }),
      ]),
    );
  });

  it("does not flag mods with disjoint file sets", async () => {
    await writeModFile("ModA", "unique-a.esp");
    await writeModFile("ModB", "unique-b.esp");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    expect(await listDuplicateMods(api)).toEqual([]);
  });
});

describe("vortexControl: listKnownModConflicts", () => {
  it("surfaces a real 'conflicts' rule between two enabled mods", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: true }, modB: { enabled: true } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [{ type: "conflicts", reference: { id: "modB" } }],
            },
            modB: { id: "modB", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listKnownModConflicts(api)).toEqual([
      { modId: "modA", modName: "modA", targetId: "modB", targetName: "modB", targetEnabled: true },
    ]);
  });

  it("reports targetEnabled: false when the conflicting mod is installed but disabled", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: true }, modB: { enabled: false } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [{ type: "conflicts", reference: { id: "modB" } }],
            },
            modB: { id: "modB", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listKnownModConflicts(api)).toEqual([
      {
        modId: "modA",
        modName: "modA",
        targetId: "modB",
        targetName: "modB",
        targetEnabled: false,
      },
    ]);
  });

  it("ignores non-conflicts rule types and disabled source mods", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: false }, modB: { enabled: true } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [{ type: "conflicts", reference: { id: "modB" } }],
            },
            modB: {
              id: "modB",
              type: "",
              installationPath: "",
              rules: [{ type: "before", reference: { id: "modA" } }],
            },
          },
        },
      },
    });

    expect(listKnownModConflicts(api)).toEqual([]);
  });

  it("surfaces logicalFileName/comment for a same-file-version-guard rule with no target modId", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: true } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [
                {
                  type: "conflicts",
                  comment: "Incompatible Script Extender",
                  reference: { logicalFileName: "Skyrim Script Extender VR (SKSEVR)" },
                },
              ],
            },
          },
        },
      },
    });

    expect(listKnownModConflicts(api)).toEqual([
      {
        modId: "modA",
        modName: "modA",
        targetId: undefined,
        targetName: undefined,
        logicalFileName: "Skyrim Script Extender VR (SKSEVR)",
        targetEnabled: false,
        comment: "Incompatible Script Extender",
      },
    ]);
  });

  it("surfaces versionMatch to distinguish two same-file-version-guard rules that would otherwise look identical", () => {
    // Found live: a mod can carry two "conflicts" rules against its own logicalFileName,
    // one per incompatible version range, distinguishable only by reference.versionMatch.
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: true } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [
                {
                  type: "conflicts",
                  comment: "Incompatible Script Extender",
                  reference: { logicalFileName: "SKSEVR", versionMatch: "<2.0.12||>2.0.12" },
                },
                {
                  type: "conflicts",
                  comment: "Incompatible Script Extender",
                  reference: { logicalFileName: "SKSEVR", versionMatch: "<2.0.11||>2.0.11" },
                },
              ],
            },
          },
        },
      },
    });

    const result = listKnownModConflicts(api);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.versionMatch)).toEqual(["<2.0.12||>2.0.12", "<2.0.11||>2.0.11"]);
  });
});

describe("vortexControl: listUnsolvedConflicts", () => {
  function apiWithConflicts(
    mods: Record<string, { rules?: unknown[] }>,
    conflicts: Record<string, unknown[]>,
  ) {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: mods } },
      session: { dependencies: { conflicts } },
    });
    return api;
  }

  it("surfaces an unresolved conflict with Vortex's own suggestion", () => {
    const api = apiWithConflicts(
      {
        modA: { id: "modA", installationPath: "", type: "" } as never,
        modB: { id: "modB", installationPath: "", type: "" } as never,
      },
      {
        modA: [
          {
            otherMod: { id: "modB", name: "Mod B" },
            files: ["Data/x.esp"],
            suggestion: "before",
          },
        ],
      },
    );

    expect(listUnsolvedConflicts(api)).toEqual([
      {
        modId: "modA",
        modName: "modA",
        otherModId: "modB",
        otherModName: "Mod B",
        files: ["Data/x.esp"],
        suggestion: "before",
      },
    ]);
  });

  it("dedupes a conflict recorded under both mods' keys (bidirectional state)", () => {
    const api = apiWithConflicts(
      {
        modA: { id: "modA", installationPath: "", type: "" } as never,
        modB: { id: "modB", installationPath: "", type: "" } as never,
      },
      {
        modA: [{ otherMod: { id: "modB" }, files: ["x.esp"], suggestion: "before" }],
        modB: [{ otherMod: { id: "modA" }, files: ["x.esp"], suggestion: "after" }],
      },
    );

    expect(listUnsolvedConflicts(api)).toHaveLength(1);
  });

  it("drops a conflict already resolved by a before/after/conflicts rule on either mod", () => {
    const api = apiWithConflicts(
      {
        modA: {
          id: "modA",
          installationPath: "",
          type: "",
          rules: [{ type: "before", reference: { id: "modB" } }],
        } as never,
        modB: { id: "modB", installationPath: "", type: "" } as never,
      },
      {
        modA: [{ otherMod: { id: "modB" }, files: ["x.esp"], suggestion: "before" }],
      },
    );

    expect(listUnsolvedConflicts(api)).toEqual([]);
  });

  it("throws when there is no active game", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("");

    expect(() => listUnsolvedConflicts(fakeApi())).toThrow(/No active game/);
  });
});

describe("vortexControl: findMissingDeployedFiles", () => {
  let gameRoot: string;
  let docsRoot: string;

  beforeEach(async () => {
    gameRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-game-"));
    docsRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-docs2-"));
    await mkdir(path.join(gameRoot, "Data"), { recursive: true });
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(util.getVortexPath).mockReturnValue(docsRoot);
  });

  afterEach(async () => {
    await rm(gameRoot, { recursive: true, force: true });
    await rm(docsRoot, { recursive: true, force: true });
  });

  function apiWithLoadOrder(loadOrder: Record<string, { loadOrder: number; enabled: boolean }>) {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { gameMode: { discovered: { skyrimse: { path: gameRoot } } } },
      loadOrder,
    });
    return api;
  }

  async function writePluginsTxt(lines: string[]): Promise<void> {
    // Mirrors the real location: <localAppData>/<myGamesFolder>/plugins.txt (util.getVortexPath
    // is mocked to docsRoot standing in for localAppData here).
    const dir = path.join(docsRoot, "Skyrim Special Edition");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugins.txt"), lines.join("\r\n"));
  }

  it("flags a plugin Vortex thinks is enabled but was never actually deployed", async () => {
    // Skyrim.esm: consistently enabled everywhere -- no discrepancy.
    await writeFile(path.join(gameRoot, "Data", "Skyrim.esm"), "x");
    await writePluginsTxt(["*Skyrim.esm", "Missing.esp"]);
    const api = apiWithLoadOrder({
      "Skyrim.esm": { loadOrder: 0, enabled: true },
      "Missing.esp": { loadOrder: 1, enabled: true },
    });

    const result = await findMissingDeployedFiles(api);

    expect(result).toEqual([
      {
        plugin: "Missing.esp",
        vortexEnabled: true,
        existsInDataFolder: false,
        activeInPluginsTxt: false,
      },
    ]);
  });

  it("reports nothing when Vortex, the Data folder, and plugins.txt all agree", async () => {
    await writeFile(path.join(gameRoot, "Data", "Skyrim.esm"), "x");
    await writePluginsTxt(["*Skyrim.esm"]);
    const api = apiWithLoadOrder({ "Skyrim.esm": { loadOrder: 0, enabled: true } });

    expect(await findMissingDeployedFiles(api)).toEqual([]);
  });

  it("flags a plugin active in plugins.txt that Vortex doesn't know about", async () => {
    await writeFile(path.join(gameRoot, "Data", "Skyrim.esm"), "x");
    await writeFile(path.join(gameRoot, "Data", "Orphan.esp"), "x");
    await writePluginsTxt(["*Skyrim.esm", "*Orphan.esp"]);
    const api = apiWithLoadOrder({ "Skyrim.esm": { loadOrder: 0, enabled: true } });

    const result = await findMissingDeployedFiles(api);

    expect(result).toEqual([
      {
        plugin: "Orphan.esp",
        vortexEnabled: false,
        existsInDataFolder: true,
        activeInPluginsTxt: true,
      },
    ]);
  });

  it("does not flag a master that's enabled+deployed but absent from plugins.txt", async () => {
    // Regression test: found live that game/DLC masters (Skyrim.esm, Update.esm, ...) are
    // activated implicitly by the engine and never appear in plugins.txt at all -- an
    // earlier version of this function treated "not listed" the same as "listed inactive"
    // and would have flagged every single master as a permanent false discrepancy.
    await writeFile(path.join(gameRoot, "Data", "Skyrim.esm"), "x");
    await writeFile(path.join(gameRoot, "Data", "Dawnguard.esm"), "x");
    await writePluginsTxt([]); // no entries at all -- neither master is listed
    const api = apiWithLoadOrder({
      "Skyrim.esm": { loadOrder: 0, enabled: true },
      "Dawnguard.esm": { loadOrder: 1, enabled: true },
    });

    expect(await findMissingDeployedFiles(api)).toEqual([]);
  });
});

describe("vortexControl: findOrphanedFiles", () => {
  let gameRoot: string;

  beforeEach(async () => {
    gameRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-orphan-"));
    await mkdir(path.join(gameRoot, "Data"), { recursive: true });
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
  });

  afterEach(async () => {
    await rm(gameRoot, { recursive: true, force: true });
  });

  function apiWithMods(mods: Record<string, { installationPath: string }>) {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { gameMode: { discovered: { skyrimse: { path: gameRoot } } } },
      persistent: { mods: { skyrimse: mods } },
    });
    return api;
  }

  async function writeManifest(files: Array<{ relPath: string; source: string }>): Promise<void> {
    await writeFile(
      path.join(gameRoot, "Data", "vortex.deployment.json"),
      JSON.stringify({ version: 1, instance: "test", files }),
    );
  }

  it("flags a manifest-tracked file still on disk whose source mod no longer exists", async () => {
    await writeFile(path.join(gameRoot, "Data", "Leftover.esp"), "x");
    await writeManifest([{ relPath: "Leftover.esp", source: "Uninstalled Mod-1.0" }]);
    const api = apiWithMods({});

    expect(await findOrphanedFiles(api)).toEqual([
      { relPath: "Leftover.esp", source: "Uninstalled Mod-1.0" },
    ]);
  });

  it("does not flag a file whose source matches a currently-installed mod's installationPath", async () => {
    await writeFile(path.join(gameRoot, "Data", "Current.esp"), "x");
    await writeManifest([{ relPath: "Current.esp", source: "Current Mod-1.0" }]);
    const api = apiWithMods({ modA: { installationPath: "Current Mod-1.0" } });

    expect(await findOrphanedFiles(api)).toEqual([]);
  });

  it("does not flag a manifest entry whose file was already removed from disk", async () => {
    // The manifest itself can be stale -- only report files genuinely still present.
    await writeManifest([{ relPath: "AlreadyGone.esp", source: "Uninstalled Mod-1.0" }]);
    const api = apiWithMods({});

    expect(await findOrphanedFiles(api)).toEqual([]);
  });

  it("returns an empty array when no manifest exists yet (never deployed)", async () => {
    const api = apiWithMods({});

    expect(await findOrphanedFiles(api)).toEqual([]);
  });
});

describe("vortexControl: checkNexusModUpdates", () => {
  it("checkNexusModUpdates only checks installed mods sourced from nexus", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const nexusCheckModsVersion = vi.fn(async () => ["modA"]);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: { id: "modA", attributes: { source: "nexus" } },
            modB: { id: "modB", attributes: { source: "manual" } },
          },
        },
      },
    });
    (api as unknown as { ext: Record<string, unknown> }).ext = { nexusCheckModsVersion };

    const result = await checkNexusModUpdates(api);

    expect(nexusCheckModsVersion).toHaveBeenCalledWith(
      "skyrimse",
      [expect.objectContaining({ id: "modA" })],
      false,
    );
    expect(result).toEqual({ checkedCount: 1, updatedModIds: ["modA"], eligibleCount: 1 });
  });

  it("caps the default (no modIds) form at `limit`, reporting the true eligible count", async () => {
    // Regression test: the unscoped form was found live to reliably exceed a 300s MCP
    // call timeout even on a modest modlist -- the fix caps what it attempts by default
    // instead of letting the caller discover the timeout.
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const nexusCheckModsVersion = vi.fn(
      async (_gameId: string, _mods: unknown[], _forceFull: boolean) => [] as string[],
    );
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: { id: "modA", attributes: { source: "nexus" } },
            modB: { id: "modB", attributes: { source: "nexus" } },
            modC: { id: "modC", attributes: { source: "nexus" } },
          },
        },
      },
    });
    (api as unknown as { ext: Record<string, unknown> }).ext = { nexusCheckModsVersion };

    const result = await checkNexusModUpdates(api, undefined, undefined, 2);

    expect(nexusCheckModsVersion.mock.calls[0][1]).toHaveLength(2);
    expect(result).toEqual({ checkedCount: 2, updatedModIds: [], eligibleCount: 3 });
  });

  it("applies limit to an explicit modIds list too (same timeout risk either way)", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const nexusCheckModsVersion = vi.fn(
      async (_gameId: string, _mods: unknown[], _forceFull: boolean) => [] as string[],
    );
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: { id: "modA", attributes: { source: "nexus" } },
            modB: { id: "modB", attributes: { source: "nexus" } },
            modC: { id: "modC", attributes: { source: "nexus" } },
          },
        },
      },
    });
    (api as unknown as { ext: Record<string, unknown> }).ext = { nexusCheckModsVersion };

    const result = await checkNexusModUpdates(api, undefined, ["modA", "modB", "modC"], 2);

    expect(nexusCheckModsVersion.mock.calls[0][1]).toHaveLength(2);
    expect(result).toEqual({ checkedCount: 2, updatedModIds: [], eligibleCount: 3 });
  });
});

describe("vortexControl: findStaleDownloads", () => {
  it("groups downloads sharing the same Nexus mod id, flagging the installed one", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            dOld: {
              game: ["skyrimse"],
              localPath: "Cool Mod v1.zip",
              state: "finished",
              startTime: 100,
              modInfo: { nexus: { ids: { modId: 42 } }, meta: { fileVersion: "1.0" } },
            },
            dNew: {
              game: ["skyrimse"],
              localPath: "Cool Mod v2.zip",
              state: "finished",
              startTime: 200,
              installed: { modId: "Cool Mod-42-2-0" },
              modInfo: { nexus: { ids: { modId: 42 } }, meta: { fileVersion: "2.0" } },
            },
            dUnrelated: {
              game: ["skyrimse"],
              localPath: "Other Mod.zip",
              state: "finished",
              startTime: 50,
              modInfo: { nexus: { ids: { modId: 99 } }, meta: { fileVersion: "1.0" } },
            },
          },
        },
      },
    });

    const result = findStaleDownloads(api);

    expect(result).toEqual([
      {
        nexusModId: 42,
        downloads: [
          {
            downloadId: "dNew",
            fileName: "Cool Mod v2.zip",
            fileVersion: "2.0",
            state: "finished",
            startTime: 200,
            installed: true,
          },
          {
            downloadId: "dOld",
            fileName: "Cool Mod v1.zip",
            fileVersion: "1.0",
            state: "finished",
            startTime: 100,
            installed: false,
          },
        ],
      },
    ]);
  });

  it("omits downloads with only one entry for their Nexus mod id", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            d1: {
              game: ["skyrimse"],
              state: "finished",
              startTime: 100,
              modInfo: { nexus: { ids: { modId: 1 } } },
            },
          },
        },
      },
    });

    expect(findStaleDownloads(api)).toEqual([]);
  });

  it("ignores downloads for a different game", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            d1: {
              game: ["fallout4"],
              state: "finished",
              startTime: 100,
              modInfo: { nexus: { ids: { modId: 1 } } },
            },
            d2: {
              game: ["fallout4"],
              state: "finished",
              startTime: 200,
              modInfo: { nexus: { ids: { modId: 1 } } },
            },
          },
        },
      },
    });

    expect(findStaleDownloads(api)).toEqual([]);
  });
});

describe("vortexControl: findStaleMods", () => {
  it("lists disabled mods sorted oldest-disabled first, with install time when known", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: {
        modA: { enabled: false, enabledTime: 300 },
        modB: { enabled: false, enabledTime: 100 },
        modC: { enabled: true, enabledTime: 500 },
      },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: { id: "modA", type: "", installationPath: "", attributes: {} },
            modB: {
              id: "modB",
              type: "",
              installationPath: "",
              attributes: { installTime: "2020-01-01T00:00:00.000Z" },
            },
            modC: { id: "modC", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(findStaleMods(api)).toEqual([
      {
        modId: "modB",
        modName: "modB",
        disabledSince: 100,
        installTime: "2020-01-01T00:00:00.000Z",
      },
      { modId: "modA", modName: "modA", disabledSince: 300, installTime: undefined },
    ]);
  });

  it("throws for an unknown explicit profileId", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.profiles).mockReturnValue({});
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: {} } },
    });

    expect(() => findStaleMods(api, { profileId: "missing" })).toThrow(/Unknown profile/);
  });

  it("respects limit", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: {
        modA: { enabled: false, enabledTime: 100 },
        modB: { enabled: false, enabledTime: 200 },
      },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: { id: "modA", type: "", installationPath: "" },
            modB: { id: "modB", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(findStaleMods(api, { limit: 1 })).toHaveLength(1);
  });
});
