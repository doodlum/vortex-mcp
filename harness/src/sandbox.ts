import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "./config";

/** A disposable install for UI, local archive, deploy and purge tests. Cannot run the game. */
export function sandboxConfig(config: HarnessConfig): HarnessConfig {
  const gamePath = path.join(config.cacheDir, "sandbox", "game");
  fs.mkdirSync(path.join(gamePath, "Data"), { recursive: true });
  const executable = path.join(gamePath, "game.exe");
  if (!fs.existsSync(executable))
    fs.writeFileSync(executable, "Vortex automation fixture; not executable.\n");
  return { ...config, gameId: "vortexaisandbox", gamePath };
}

/** A real game-support extension, without game-specific writes to Documents or AppData. */
export function installSandboxExtension(instanceDir: string, config: HarnessConfig): void {
  if (config.gameId !== "vortexaisandbox") return;
  const dir = path.join(instanceDir, "userData", "plugins", "game-vortex-ai-sandbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "info.json"),
    JSON.stringify({
      id: "game-vortex-ai-sandbox",
      name: "Vortex Automation Sandbox",
      author: "vortex-mcp",
      version: "1.0.0",
      description: "Disposable game for automation tests",
    }),
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ type: "commonjs", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `module.exports.default = function(context) {
    context.registerGame({ id: "vortexaisandbox", name: "Vortex Automation Sandbox",
      queryPath: () => Promise.resolve(${JSON.stringify(config.gamePath)}),
      queryModPath: () => "Data", executable: () => "game.exe", requiredFiles: ["game.exe"],
      supportedTools: [], environment: {}, mergeMods: true });
    return true;
  };\n`,
  );
}
