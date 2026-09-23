import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertRedirected,
  bethesdaSandboxConfig,
  ensureBethesdaSandbox,
  pluginBytes,
} from "./bethesdaSandbox";
import type { HarnessConfig } from "./config";

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
