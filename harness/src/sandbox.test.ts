import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HarnessConfig } from "./config";
import { resetDisposableGameData } from "./sandbox";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function game(cacheDir: string, inside = true) {
  const gamePath = inside
    ? path.join(cacheDir, "sandbox", "game")
    : fs.mkdtempSync(path.join(os.tmpdir(), "outside-game-"));
  if (!inside) dirs.push(gamePath);
  const data = path.join(gamePath, "Data");
  fs.mkdirSync(path.join(data, "textures"), { recursive: true });
  fs.writeFileSync(path.join(data, "Fallout4.esm"), "master");
  fs.writeFileSync(path.join(data, "vortex.deployment.json"), "{}");
  fs.writeFileSync(path.join(data, "textures", "x.dds"), "x");
  return { config: { cacheDir, gamePath } as HarnessConfig, data };
}

describe("resetDisposableGameData", () => {
  it("empties Data, keeping the fixture's own files and removing plugin lists", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "reset-game-"));
    dirs.push(cache);
    const { config, data } = game(cache);
    const lists = path.join(cache, "Local", "Fallout4");
    fs.mkdirSync(lists, { recursive: true });
    fs.writeFileSync(path.join(lists, "plugins.txt"), "*A.esp");

    expect(resetDisposableGameData(config, { keep: ["fallout4.esm"], pluginLists: lists })).toBe(
      true,
    );
    expect(fs.readdirSync(data)).toEqual(["Fallout4.esm"]);
    expect(fs.existsSync(path.join(lists, "plugins.txt"))).toBe(false);
  });

  it("never touches a game outside the harness cache", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "reset-game-"));
    dirs.push(cache);
    const { config, data } = game(cache, false);
    expect(resetDisposableGameData(config)).toBe(false);
    expect(fs.readdirSync(data).sort()).toEqual(
      ["Fallout4.esm", "textures", "vortex.deployment.json"].sort(),
    );
  });
});
