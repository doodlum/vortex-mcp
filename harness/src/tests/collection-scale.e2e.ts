/**
 * Opt-in performance check of a large collection install: pnpm run ai:test:collection-scale.
 *
 * Installs an offline collection of N members that are all already installed, so nothing
 * downloads or installs. Everything between Install Now and the review screen is Vortex
 * resolving and recording the members, which is what froze the UI for tens of seconds on
 * large collections (LAZ-916, Nexus-Mods/Vortex#24283).
 *
 * Reports wall time, main-thread long tasks, a renderer CPU profile's top functions and
 * files (the `.cpuprofile` is saved beside the JSON), and the step timings from Vortex's
 * own log. Fails when any single freeze exceeds the budget. Needs no account; run it on the
 * plain sandbox game, against a source or installed build.
 *
 *   --members <n>   collection size (default 2000)
 */
import fs from "node:fs";
import path from "node:path";

import { attachToRenderer } from "../cdp";
import { loadConfig } from "../config";
import { claimInstanceLease } from "../instance";
import { referenceTag, seedLibrary } from "../largeLibrary";
import { VortexMcpClient } from "../mcpClient";
import { installOfflineCollection, writeOfflineCollection } from "../offlineCollection";
import { profileRenderer } from "../profiling";
import { markLog, readSince, summariseLog, type LogEntry } from "../vortexLog";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const members = Number(flag("members") ?? 2000);
/** The longest the UI may be frozen at a stretch. 2.7 with 2,000 members: 26.5s. */
const MAX_FREEZE_MS = 10_000;

const config = loadConfig();
// Drives the running instance: refuse while another owner holds it.
claimInstanceLease(config, "ai:test:collection-scale");
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
if (
  (await mcp.call<string | null>("vortex_query", { selector: "activeGameId" })) !==
  "vortexaisandbox"
) {
  throw new Error("Run this on the sandbox game: `vortex-ai up --sandbox`.");
}

const library = await seedLibrary(mcp, { count: members, filesPerMod: 1, tagged: true });
// Measure with another page open, so the Mods page's own rendering is not the thing timed.
await mcp.call("vortex_dispatch", { action: "setOpenMainPage", args: ["Settings", false] });
const stamp = String(Date.now());
const archive = writeOfflineCollection(
  path.join(config.cacheDir, `collection-scale-${stamp}.zip`),
  {
    name: `Collection scale ${stamp}`,
    gameId: library.gameId,
    members: library.modIds.map((id) => ({ name: id, files: {}, tag: referenceTag(id) })),
  },
);

/** Time from the first log line matching `from` to the next line matching `to`. */
function between(entries: LogEntry[], from: RegExp, to: RegExp): number | null {
  const start = entries.findIndex((e) => from.test(e.message));
  if (start === -1) return null;
  const end = entries.findIndex((e, i) => i > start && to.test(e.message));
  if (end === -1) return null;
  return Date.parse(entries[end]?.time ?? "") - Date.parse(entries[start]?.time ?? "");
}

const statusInfo = await mcp.call<{ userDataDir: string | null }>("automation_status");
const mark = markLog(statusInfo.userDataDir ?? path.join(config.cacheDir, "live", "userData"));
const handle = await attachToRenderer(config);
await mcp.call("perf_trace_start", {});
const start = Date.now();
const { summary, file } = await profileRenderer(
  handle.page,
  () => installOfflineCollection(mcp, archive, { timeoutMs: 1_800_000 }),
  { artifactDir: config.artifactDir, label: "collection-scale", top: 10 },
);
const wallMs = Date.now() - start;
const trace = await mcp.call<{ longTasks: { count: number; totalMs: number; maxMs: number } }>(
  "perf_trace_stop",
  { top: 8 },
);
await handle.close();

const entries = readSince(mark);
const processed = entries.find((e) => e.message === "processed instructions")?.data?.duration;
const result = {
  members,
  wallMs,
  longTasks: trace.longTasks,
  steps: {
    addingMemberRulesMs: typeof processed === "number" ? processed : null,
    gatheringDependenciesMs: between(
      entries,
      /^starting install of collection$/,
      /^determined unfulfilled dependencies$/,
    ),
    updatingRulesMs: between(
      entries,
      /^determined unfulfilled dependencies$/,
      /^postprocess collection$/,
    ),
  },
  hotFunctions: summary.functions,
  hotFiles: summary.files,
  log: summariseLog(entries),
  cpuprofile: file,
  failures: [] as string[],
};
if (trace.longTasks.maxMs > MAX_FREEZE_MS) {
  result.failures.push(
    `the UI froze for ${String(Math.round(trace.longTasks.maxMs))}ms at a stretch ` +
      `(allowed ${String(MAX_FREEZE_MS)})`,
  );
}

fs.mkdirSync(config.artifactDir, { recursive: true });
const report = path.join(config.artifactDir, `collection-scale-${String(Date.now())}.json`);
fs.writeFileSync(report, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, hotFunctions: result.hotFunctions.slice(0, 5) }, null, 2));
console.log(`evidence: ${report}`);
if (result.failures.length > 0) {
  console.error(`\nFAILED:\n  ${result.failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
