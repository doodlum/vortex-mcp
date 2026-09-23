import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { installLocalMod } from "../localMod";
import { deployMods, purgeGame } from "../deployment";
import { expect, test } from "./fixtures";

test("local archive installs, enables, deploys real bytes, disables, and purges", async ({
  config,
  managedGame,
  mcp,
}) => {
  const content = "Vortex automation end-to-end proof\n";
  const archive = path.join(config.cacheDir, "automation-probe.zip");
  fs.writeFileSync(archive, zipSync({ "textures/automation-probe.txt": strToU8(content) }));
  const { modId } = await installLocalMod(mcp, archive);
  await mcp.call("set_mods_enabled", {
    modIds: [modId],
    enabled: true,
    expectedActiveGameId: managedGame.gameId,
  });
  const deployed = path.join(managedGame.gamePath, "Data", "textures", "automation-probe.txt");
  try {
    await deployMods(mcp, managedGame.gameId, { timeoutMs: 90_000 });
    expect(fs.readFileSync(deployed, "utf8")).toBe(content);
    await mcp.call("set_mods_enabled", { modIds: [modId], enabled: false });
    await deployMods(mcp, managedGame.gameId, { timeoutMs: 90_000 });
    expect(fs.existsSync(deployed)).toBe(false);
    await mcp.call("set_mods_enabled", { modIds: [modId], enabled: true });
    await deployMods(mcp, managedGame.gameId, { timeoutMs: 90_000 });
    expect(fs.readFileSync(deployed, "utf8")).toBe(content);
    await purgeGame(mcp, { timeoutMs: 90_000 });
    expect(fs.existsSync(deployed)).toBe(false);
  } finally {
    await mcp.call("set_mods_enabled", { modIds: [modId], enabled: false });
  }
});
