import fs from "node:fs";
import path from "node:path";
import type { VortexMcpClient } from "./mcpClient";
import { autoAdvanceFomods, autoAnswerDialogs } from "./uiDriver";

/** Install a local archive through Vortex's normal installer; no native file picker. */
export async function installLocalMod(
  mcp: VortexMcpClient,
  archive: string,
): Promise<{ modId: string; gameId: string }> {
  const file = path.resolve(archive);
  if (!fs.statSync(file).isFile()) throw new Error(`Not an archive file: ${file}`);
  const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
  if (!gameId) throw new Error("Manage a game before installing a local mod.");
  const controller = new AbortController();
  const watchers = [
    autoAnswerDialogs(mcp, { signal: controller.signal }),
    autoAdvanceFomods(mcp, { signal: controller.signal }),
  ];
  try {
    const modId = await mcp.call<string>(
      "vortex_dispatch",
      { action: "start-install", args: [file, "__CALLBACK__"] },
      300_000,
    );
    if (typeof modId !== "string" || !modId)
      throw new Error("Vortex did not return an installed mod id.");
    const mod = await mcp.call<{ state: string } | null>("vortex_query", {
      path: ["persistent", "mods", gameId, modId],
    });
    if (mod?.state !== "installed") throw new Error(`Vortex has not finished installing ${modId}.`);
    return { modId, gameId };
  } finally {
    controller.abort();
    await Promise.allSettled(watchers);
  }
}
