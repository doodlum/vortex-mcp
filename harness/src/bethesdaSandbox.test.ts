import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertRedirected,
  bethesdaSandboxConfig,
  deterministicLoadOrder,
  ensureBethesdaSandbox,
  pluginBytes,
  setDeterministicLoadOrder,
} from "./bethesdaSandbox";
import type { HarnessConfig } from "./config";
import type { VortexMcpClient } from "./mcpClient";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bethesda-sandbox-"));
  dirs.push(dir);
  return dir;
};

/** Read a plugin's TES4 header the way a Bethesda header reader does. */
function readHeader(bytes: Buffer): { flags: number; masters: string[]; records: number } {
  expect(bytes.toString("ascii", 0, 4)).toBe("TES4");
  const size = bytes.readUInt32LE(4);
  const flags = bytes.readUInt32LE(8);
  const masters: string[] = [];
  let records = -1;
  for (let at = 24; at < 24 + size;) {
    const tag = bytes.toString("ascii", at, at + 4);
    const length = bytes.readUInt16LE(at + 4);
    const data = bytes.subarray(at + 6, at + 6 + length);
    if (tag === "MAST") masters.push(data.toString("latin1", 0, data.length - 1));
    if (tag === "HEDR") records = data.readUInt32LE(4);
    at += 6 + length;
  }
  expect(24 + size).toBe(bytes.length);
  return { flags, masters, records };
}

describe("pluginBytes", () => {
  it("writes masters in order, each with its DATA", () => {
    const bytes = pluginBytes({ name: "A.esp", masters: ["Fallout4.esm", "B.esm"] });
    expect(readHeader(bytes)).toEqual({ flags: 0, masters: ["Fallout4.esm", "B.esm"], records: 1 });
    expect(bytes.includes(Buffer.from("DATA"))).toBe(true);
  });

  it("flags masters and light plugins from the extension", () => {
    expect(readHeader(pluginBytes({ name: "B.esm" })).flags).toBe(0x1);
    expect(readHeader(pluginBytes({ name: "C.esl" })).flags).toBe(0x201);
    expect(readHeader(pluginBytes({ name: "D.esp", light: true })).flags).toBe(0x201);
  });
});

describe("ensureBethesdaSandbox", () => {
  it("creates the game, its master and the INI files, and keeps existing files", () => {
    const cache = tempDir();
    const sandbox = ensureBethesdaSandbox(cache);
    expect(fs.existsSync(path.join(sandbox.gamePath, "Fallout4.exe"))).toBe(true);
    expect(readHeader(fs.readFileSync(path.join(sandbox.dataPath, "Fallout4.esm"))).flags).toBe(1);
    for (const ini of ["Fallout4.ini", "Fallout4Prefs.ini", "Fallout4Custom.ini"]) {
      expect(fs.existsSync(path.join(sandbox.myGames, ini))).toBe(true);
    }
    fs.writeFileSync(path.join(sandbox.myGames, "Fallout4.ini"), "[Vortex wrote this]\r\n");
    ensureBethesdaSandbox(cache);
    expect(fs.readFileSync(path.join(sandbox.myGames, "Fallout4.ini"), "utf8")).toContain("Vortex");
  });

  it("points the config at the fake game with both folders redirected into the cache", () => {
    const cache = tempDir();
    const config = bethesdaSandboxConfig({ cacheDir: cache } as HarnessConfig);
    expect(config.gameId).toBe("fallout4");
    for (const dir of [
      config.gamePath,
      config.profileRedirect?.documents,
      config.profileRedirect?.localAppData,
    ]) {
      expect(path.relative(cache, dir ?? "/elsewhere").startsWith("..")).toBe(false);
    }
  });
});

describe("assertRedirected", () => {
  const expected = { documents: "C:\\cache\\Documents", localAppData: "C:\\cache\\Local" };

  it("accepts the sandbox's folders, in any case", () => {
    expect(() =>
      assertRedirected(expected, {
        documents: "c:\\CACHE\\documents",
        localAppData: "C:\\cache\\Local",
      }),
    ).not.toThrow();
  });

  it("refuses the real folders, or ones Vortex could not report", () => {
    expect(() =>
      assertRedirected(expected, {
        documents: "C:\\Users\\someone\\Documents",
        localAppData: "C:\\cache\\Local",
      }),
    ).toThrow(/Refusing/);
    expect(() => assertRedirected(expected, { documents: null, localAppData: null })).toThrow();
    expect(() => assertRedirected(expected, undefined)).toThrow();
  });
});

describe("a deterministic load order", () => {
  // As Vortex left it after a deploy: discovery order, which differs run to run.
  const discovered = {
    "zeta.esp": { name: "Zeta.esp", enabled: true, loadOrder: 0 },
    "fallout4.esm": { name: "Fallout4.esm", enabled: true, loadOrder: 1 },
    "alpha.esp": { name: "alpha.esp", enabled: false, loadOrder: 2 },
    "light.esl": { name: "Light.esl", enabled: true, loadOrder: 3 },
    "master.esm": { name: "Master.esm", enabled: true, loadOrder: 4 },
    "dlcrobot.esm": { name: "DLCRobot.esm", enabled: true, loadOrder: 5 },
  };

  it("puts the natives first, then masters, light plugins and plugins by name", () => {
    const expected = [
      "Fallout4.esm",
      "DLCRobot.esm",
      "Master.esm",
      "Light.esl",
      "alpha.esp",
      "Zeta.esp",
    ];
    expect(deterministicLoadOrder(discovered)).toEqual(expected);
    // Any other discovery order gives the same.
    const shuffled = Object.fromEntries(Object.entries(discovered).toReversed());
    expect(deterministicLoadOrder(shuffled)).toEqual(expected);
  });

  it("turns autosort off, applies the order and checks that state reads back in it", async () => {
    let state: Record<string, { name?: string; enabled?: boolean; loadOrder?: number }> = {
      ...discovered,
    };
    const dispatched: unknown[] = [];
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "vortex_query") return state;
      dispatched.push(args);
      if (args.action === "type:SET_PLUGIN_ORDER") {
        // The gamebryo reducer: replace the order, keeping enabled states.
        const { plugins } = (args.args as [{ plugins: string[] }])[0];
        state = Object.fromEntries(
          plugins.map((name, i) => [
            name.toLowerCase(),
            { name, enabled: state[name.toLowerCase()]?.enabled ?? true, loadOrder: i },
          ]),
        );
      }
      return {};
    });
    const result = await setDeterministicLoadOrder({ call } as unknown as VortexMcpClient);
    expect(result.applied).toBe(true);
    expect(dispatched[0]).toEqual({ action: "type:GAMEBRYO_SET_AUTOSORT_ENABLED", args: [false] });
    expect(state["alpha.esp"]).toMatchObject({ enabled: false, loadOrder: 4 });
  });
});
