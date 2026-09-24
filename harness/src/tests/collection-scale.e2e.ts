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
 * Options add the shapes real collections have (collectionScale.ts); with none, every member
 * is required and there are no rules, as before, so older results stay comparable:
 *
 *   --members <n>      collection size (default 2000)
 *   --optional <f>     fraction of members that are optional (e.g. 0.1)
 *   --glob <f>         fraction referenced by a glob fileExpression (e.g. 0.04)
 *   --duplicates <n>   duplicate member entries (alternate ones flip optional)
 *   --rules <n>        inter-member modRules: tag, literal and glob fileExpression, and
 *                      unresolvable references, with duplicates and before/after pairs
 *   --update           then update to revision 2 the way collectionUpdate does: remove the old
 *                      collection mod keeping its members, install revision 2 (drops 5%, flips
 *                      optional members, adds --extra members, changes rules)
 *   --extra <n>        members revision 2 adds (default 50)
 *
 * Install and update are reported separately: wall time, longest freeze (the longest
 * main-thread task), long tasks, and Vortex's step timings, updateRules included.
 */
import fs from "node:fs";
import path from "node:path";

import { attachToRenderer } from "../cdp";
import { loadConfig } from "../config";
import { claimInstanceLease } from "../instance";
import { seedLibrary } from "../largeLibrary";
import { VortexMcpClient } from "../mcpClient";
import { libraryCount, scaleCollection, type ScaleOptions } from "../collectionScale";
import {
  installOfflineCollection,
  updateOfflineCollection,
  writeOfflineCollection,
  type CollectionInstallResult,
} from "../offlineCollection";
import { profileRenderer } from "../profiling";
import { markLog, readSince, summariseLog, type LogEntry } from "../vortexLog";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const numberFlag = (name: string): number | undefined => {
  const value = flag(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} needs a number.`);
  return parsed;
};
const options: ScaleOptions = {
  members: numberFlag("members") ?? 2000,
  optional: numberFlag("optional"),
  glob: numberFlag("glob"),
  duplicates: numberFlag("duplicates"),
  rules: numberFlag("rules"),
  extra: numberFlag("extra"),
};
const update = process.argv.includes("--update");
/**
 * The longest the UI may be frozen at a stretch. Master of September 2026, 2,000 members,
 * production React: 21.2s (the 26.5s once noted here was probably development React).
 */
const MAX_FREEZE_MS = 10_000;

const config = loadConfig();
// Drives the running instance: refuse while another owner holds it.
claimInstanceLease(config, "ai:test:collection-scale", {}, { attach: true });
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
if (
  (await mcp.call<string | null>("vortex_query", { selector: "activeGameId" })) !==
  "vortexaisandbox"
) {
  throw new Error("Run this on the sandbox game: `vortex-ai up --sandbox`.");
}
const status = await mcp.call<{
  userDataDir: string | null;
  nodeEnv?: string | null;
  react?: { build?: string };
}>("automation_status");

const library = await seedLibrary(mcp, {
  count: update ? libraryCount(options) : options.members,
  filesPerMod: 1,
  tagged: true,
});
// Measure with another page open, so the Mods page's own rendering is not the thing timed.
await mcp.call("vortex_dispatch", { action: "setOpenMainPage", args: ["Settings", false] });
const stamp = String(Date.now());
const archiveFor = (revision: 1 | 2): string =>
  writeOfflineCollection(
    path.join(config.cacheDir, `collection-scale-${stamp}-rev${String(revision)}.zip`),
    scaleCollection(
      library.modIds,
      library.gameId,
      { ...options, extra: update ? options.extra : 0 },
      revision,
      `Collection scale ${stamp}`,
    ),
  );

/** Time from the first log line matching `from` to the next line matching `to`. */
function between(entries: LogEntry[], from: RegExp, to: RegExp): number | null {
  const start = entries.findIndex((e) => from.test(e.message));
  if (start === -1) return null;
  const end = entries.findIndex((e, i) => i > start && to.test(e.message));
  if (end === -1) return null;
  return Date.parse(entries[end]?.time ?? "") - Date.parse(entries[start]?.time ?? "");
}

interface Phase {
  wallMs: number;
  longestFreezeMs: number;
  longTasks: { count: number; totalMs: number; maxMs: number };
  steps: {
    addingMemberRulesMs: number | null;
    gatheringDependenciesMs: number | null;
    updatingRulesMs: number | null;
  };
  outcome: CollectionInstallResult["outcome"];
  postprocessed?: boolean;
  removeMs?: number;
  hotFunctions: unknown[];
  hotFiles: unknown[];
  log: unknown;
  cpuprofile: string | undefined;
}

async function measure(
  label: string,
  run: () => Promise<{ install: CollectionInstallResult; removeMs?: number }>,
): Promise<Phase & { collectionModId: string }> {
  const mark = markLog(status.userDataDir ?? path.join(config.cacheDir, "live", "userData"));
  const handle = await attachToRenderer(config);
  await mcp.call("perf_trace_start", {});
  const start = Date.now();
  const { result, summary, file } = await profileRenderer(handle.page, run, {
    artifactDir: config.artifactDir,
    label,
    top: 10,
  });
  const wallMs = Date.now() - start;
  const trace = await mcp.call<{ longTasks: { count: number; totalMs: number; maxMs: number } }>(
    "perf_trace_stop",
    { top: 8 },
  );
  await handle.close();
  const entries = readSince(mark);
  const processed = entries.find((e) => e.message === "processed instructions")?.data?.duration;
  return {
    collectionModId: result.install.collectionModId,
    wallMs,
    longestFreezeMs: trace.longTasks.maxMs,
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
    outcome: result.install.outcome,
    postprocessed: result.install.postprocessed,
    ...(result.removeMs === undefined ? {} : { removeMs: result.removeMs }),
    hotFunctions: summary.functions,
    hotFiles: summary.files,
    log: summariseLog(entries),
    cpuprofile: file,
  };
}

// A required member that already exists never fails; optional ones are skipped at the review.
const installOptions = { timeoutMs: 1_800_000, allowIncomplete: true };
const install = await measure("collection-scale", async () => ({
  install: await installOfflineCollection(mcp, archiveFor(1), installOptions),
}));
const phases: Record<string, Phase> = { install };
if (update) {
  phases.update = await measure("collection-scale-update", () =>
    updateOfflineCollection(mcp, install.collectionModId, archiveFor(2), installOptions),
  );
}

const failures: string[] = [];
for (const [name, phase] of Object.entries(phases)) {
  if (phase.longestFreezeMs > MAX_FREEZE_MS) {
    failures.push(
      `${name}: the UI froze for ${String(Math.round(phase.longestFreezeMs))}ms at a stretch ` +
        `(allowed ${String(MAX_FREEZE_MS)})`,
    );
  }
  if (phase.outcome !== "complete") failures.push(`${name}: the review said ${phase.outcome}`);
}
const result = {
  options: { ...options, update },
  members: options.members,
  renderer: { nodeEnv: status.nodeEnv ?? null, react: status.react?.build ?? null },
  // Kept at the top level for comparison with earlier reports (install only).
  wallMs: install.wallMs,
  longTasks: install.longTasks,
  steps: install.steps,
  phases,
  failures,
};

fs.mkdirSync(config.artifactDir, { recursive: true });
const report = path.join(config.artifactDir, `collection-scale-${String(Date.now())}.json`);
fs.writeFileSync(report, JSON.stringify(result, null, 2));
const brief = (phase: Phase): Record<string, unknown> => ({
  wallMs: phase.wallMs,
  longestFreezeMs: phase.longestFreezeMs,
  updatingRulesMs: phase.steps.updatingRulesMs,
  steps: phase.steps,
  ...(phase.removeMs === undefined ? {} : { removeMs: phase.removeMs }),
  outcome: phase.outcome,
  postprocessed: phase.postprocessed,
  top: phase.hotFunctions.slice(0, 5),
});
console.log(
  JSON.stringify(
    {
      options: result.options,
      renderer: result.renderer,
      ...Object.fromEntries(Object.entries(phases).map(([name, phase]) => [name, brief(phase)])),
    },
    null,
    2,
  ),
);
console.log(`evidence: ${report}`);
if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
