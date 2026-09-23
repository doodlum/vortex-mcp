/**
 * Opt-in check of Vortex's Bethesda-game health checks against the fake Fallout 4:
 * pnpm run ai:test:bethesda (instance started with `up --dev-dir <checkout> --bethesda-sandbox`).
 *
 * Missing Masters is the warning that tells a player their load order will crash the
 * game. It can fail silently: its check simply stops being run. This drives the two
 * scenarios that separate a working check from a silent one:
 *
 * A. A plugin whose master does not exist is installed and deployed. The check must run,
 *    flag the plugin, and raise the "Missing Masters" notification.
 * B. The same, straight after an offline collection has installed and its review screen
 *    was closed with Done. Up to at least 2.8 / master of September 2026, Vortex never
 *    released the check suppression a collection install takes, so B fails there
 *    (Nexus-Mods/Vortex#24282).
 *
 * Check runs are counted by the extension's probe (check_probe_counts), so a check that
 * never runs is told apart from one that ran and found nothing. Needs a source build:
 * the sandbox's Documents folder can only be redirected there (see mainPreload.ts).
 */
import fs from "node:fs";
import path from "node:path";

import { zipSync } from "fflate";

import { bethesdaSandboxPaths, pluginBytes } from "../bethesdaSandbox";
import { loadConfig } from "../config";
import { deployMods } from "../deployment";
import { installLocalMod } from "../localMod";
import { VortexMcpClient } from "../mcpClient";
import { installOfflineCollection, writeOfflineCollection } from "../offlineCollection";

const config = loadConfig();
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();

const status = await mcp.call<{ paths?: { documents: string | null } }>("automation_status");
const sandbox = bethesdaSandboxPaths(config.cacheDir);
if (
  (await mcp.call<string | null>("vortex_query", { selector: "activeGameId" })) !== "fallout4" ||
  path.resolve(status.paths?.documents ?? "").toLowerCase() !==
    path.resolve(sandbox.documents).toLowerCase()
) {
  throw new Error(
    "This check needs the fake Fallout 4 with its private Documents folder. Start the instance " +
      "with `vortex-ai up --dev-dir <checkout> --bethesda-sandbox`.",
  );
}

const runs = async (event: string): Promise<number> =>
  (await mcp.call<Array<{ event: string; runs: number }>>("check_probe_counts")).find(
    (c) => c.event === event,
  )?.runs ?? 0;
const flagged = async (plugin: string): Promise<boolean> => {
  const list = await mcp.call<Record<string, { warnings?: Record<string, boolean> }> | null>(
    "vortex_query",
    { path: ["session", "plugins", "pluginList"] },
  );
  return list?.[plugin.toLowerCase()]?.warnings?.["missing-master"] === true;
};
const notified = async (): Promise<boolean> =>
  (await mcp.call<Array<{ id: string }>>("list_notifications")).some(
    (n) => n.id === "test-master-missing",
  );

/** Install and deploy a plugin whose master does not exist; report what the check did. */
async function missingMasterPlugin(label: string) {
  const stamp = `${label}${String(Date.now())}`;
  const plugin = `Needs${stamp}.esp`;
  const archive = path.join(config.cacheDir, `bethesda-${stamp}.zip`);
  fs.writeFileSync(
    archive,
    zipSync({
      [plugin]: pluginBytes({ name: plugin, masters: ["Fallout4.esm", `Gone${stamp}.esm`] }),
    }),
  );
  const before = await runs("plugins-changed");
  await installLocalMod(mcp, archive);
  await deployMods(mcp, "fallout4");
  // Checks run 500ms after their event, debounced; give them a moment past that.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(await flagged(plugin))) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    plugin,
    checkRuns: (await runs("plugins-changed")) - before,
    flagged: await flagged(plugin),
    notified: await notified(),
  };
}

const failures: string[] = [];
const result: Record<string, unknown> = {};

const a = await missingMasterPlugin("A");
result.scenarioA = a;
if (!a.flagged || !a.notified) {
  failures.push(`A: a plugin with a missing master was not reported (${JSON.stringify(a)})`);
}

const stamp = String(Date.now());
const collection = writeOfflineCollection(
  path.join(config.cacheDir, `bethesda-collection-${stamp}.zip`),
  {
    name: `Bethesda check ${stamp}`,
    gameId: "fallout4",
    members: ["Alpha", "Beta"].map((name) => ({
      name: `${name}${stamp}`,
      files: {
        [`${name}${stamp}.esp`]: pluginBytes({ name: `${name}.esp`, masters: ["Fallout4.esm"] }),
      },
    })),
  },
);
result.collection = await installOfflineCollection(mcp, collection);
await new Promise((resolve) => setTimeout(resolve, 3_000));

const b = await missingMasterPlugin("B");
result.scenarioB = b;
if (b.checkRuns === 0 || !b.flagged) {
  failures.push(
    `B: after a completed collection the Missing Masters check ran ${String(b.checkRuns)} times ` +
      `and ${b.flagged ? "flagged" : "did not flag"} ${b.plugin} — Vortex is still suppressing its checks`,
  );
}

result.failures = failures;
fs.mkdirSync(config.artifactDir, { recursive: true });
const report = path.join(config.artifactDir, `bethesda-${String(Date.now())}.json`);
fs.writeFileSync(report, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(`evidence: ${report}`);
if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
