/** Opt-in live-service test: pnpm run ai:test:nexus after setup --oauth. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ConfigError, resolveTarget } from "../config";
import { bootstrap } from "../bootstrap";
import { authCacheFile, stopStaleInstance } from "../instance";
import { installCollection } from "../collections";
import { deployMods, purgeGame } from "../deployment";
import { captureScreenshot } from "../cdp";

const parent = loadConfig(
  process.argv.includes("--installed") ? { target: resolveTarget({ preferInstalled: true }) } : {},
);
const cacheDir = path.join(parent.cacheDir, "nexus-smoke");
const gamePath = path.join(cacheDir, "game");
const config = { ...parent, cacheDir, gamePath, gameId: "stardewvalley", apiKey: undefined };
const collection = "https://www.nexusmods.com/games/stardewvalley/collections/nudx7b/revisions/1";
if (!fs.existsSync(authCacheFile(parent)))
  throw new ConfigError(
    "Run pnpm run ai -- setup --oauth for this target first. This opt-in test requires a cached Nexus login and unattended downloads require a Premium account.",
  );
await stopStaleInstance(parent);
fs.mkdirSync(gamePath, { recursive: true });
fs.writeFileSync(
  path.join(gamePath, "Stardew Valley.exe"),
  "Automation path marker; not a playable game.",
);
fs.copyFileSync(authCacheFile(parent), authCacheFile(config));
try {
  const { instance, tier } = await bootstrap(config, { fresh: true, onProgress: console.log });
  await purgeGame(instance.mcp, { allowForeignPurge: true, onProgress: console.log });
  const result = await installCollection(instance.mcp, collection, {
    timeoutMs: 300_000,
    onProgress: console.log,
  });
  await deployMods(instance.mcp, config.gameId, {
    allowForeignPurge: true,
    onProgress: console.log,
  });
  const deployed: string[] = [];
  const hash = (file: string): string =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  for (const file of [
    path.join(gamePath, "Mods", "vortex.deployment.json"),
    path.join(gamePath, "vortex.deployment.SMAPI.json"),
  ]) {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
      targetPath: string;
      stagingPath: string;
      files: { target?: string; relPath: string; source: string }[];
    };
    for (const entry of manifest.files) {
      const target = path.join(manifest.targetPath, entry.target ?? "", entry.relPath);
      const source = path.join(manifest.stagingPath, entry.source, entry.relPath);
      if (hash(target) !== hash(source))
        throw new Error(`Deployment bytes differ for ${entry.relPath}`);
      deployed.push(target);
    }
  }
  if (deployed.length === 0) throw new Error("No deployed files were validated.");
  const screenshot = await captureScreenshot(config, { label: "nexus-smoke" });
  await purgeGame(instance.mcp, { onProgress: console.log });
  if (deployed.some((file) => fs.existsSync(file)))
    throw new Error("Purge left deployed files behind.");
  fs.mkdirSync(config.artifactDir, { recursive: true });
  const evidence = path.join(config.artifactDir, `nexus-smoke-${Date.now()}.json`);
  fs.writeFileSync(
    evidence,
    JSON.stringify(
      {
        collection,
        tier,
        ...result,
        deployedFilesVerified: deployed.length,
        purgeVerified: true,
        gameLaunch: "not tested: disposable executable marker",
        screenshot,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: ${result.modCount}/${result.expectedModCount} required mods; ${deployed.length} file hashes and purge verified. ${evidence}`,
  );
} finally {
  await stopStaleInstance(config);
  // Preserve any refresh-token rotation for later setup/up/test invocations.
  if (fs.existsSync(authCacheFile(config)))
    fs.copyFileSync(authCacheFile(config), authCacheFile(parent));
}
