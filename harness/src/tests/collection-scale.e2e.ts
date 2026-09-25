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
 *   --missing-optional the optional members are not installed beforehand, so the review offers
 *                      them (Install optional mods / No Thanks) instead of showing only Done
 *   --optionals <m>    at the review: skip (No Thanks, default), install (really install
 *                      them), or stand-in (click Install optional mods, then complete that pass
 *                      without installing: completeOptionalsWithoutInstall)
 *
 * Install and update are reported separately: wall time, longest freeze (the longest
 * main-thread task), long tasks, Vortex's step timings, updateRules included, the button that
 * closed the review, every action type's dispatch count and time, and the CPU profile's
 * functions by self and by inclusive time. Each phase of the install (Install Now, review shown,
 * review closed, ...) is marked: `performance.mark` in the renderer, and `marks` in the JSON
 * with their offset in the `.cpuprofile`, which `windows` then summarises one by one.
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
  type CollectionPhase,
  type InstallCollectionOptions,
} from "../offlineCollection";
import {
  profileRenderer,
  summariseWindows,
  windowsFromMarks,
  type ProfileMark,
} from "../profiling";
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
  missingOptional: process.argv.includes("--missing-optional"),
};
const update = process.argv.includes("--update");
const optionalsMode = flag("optionals") ?? "skip";
if (!["skip", "install", "stand-in"].includes(optionalsMode)) {
  throw new Error("--optionals is skip, install or stand-in.");
}
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

interface TraceSummary {
  durationMs: number;
  dispatches: { count: number; totalMs: number };
  byTime: Array<{ type: string; count: number; totalMs: number; maxMs: number }>;
  byCount: Array<{ type: string; count: number; totalMs: number; maxMs: number }>;
  longTasks: { count: number; totalMs: number; maxMs: number };
  heapMb: { start: number; max: number; end: number } | null;
}

interface PhaseMark extends ProfileMark {
  detail?: string;
  /** Wall-clock time, for lining the mark up with Vortex's log. */
  time: string;
}

interface Phase {
  wallMs: number;
  longestFreezeMs: number;
  longTasks: { count: number; totalMs: number; maxMs: number };
  /** The button that closed the review (Done, No Thanks, Close). */
  closedWith: string;
  /** Every action type dispatched during the phase, by count and by time (perf_trace). */
  dispatches: Pick<TraceSummary, "dispatches" | "byCount" | "byTime">;
  marks: PhaseMark[];
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
  /** Functions by inclusive time (callees included), dependencies included and not. */
  inclusive: unknown[];
  inclusiveApp: unknown[];
  longestBusy: unknown;
  /** The profile between consecutive marks: busy time, inclusive top, longest freeze. */
  windows: unknown[];
  log: unknown;
  cpuprofile: string | undefined;
}

async function measure(
  label: string,
  run: (onPhase: InstallCollectionOptions["onPhase"]) => Promise<{
    install: CollectionInstallResult;
    removeMs?: number;
  }>,
): Promise<Phase & { collectionModId: string }> {
  const mark = markLog(status.userDataDir ?? path.join(config.cacheDir, "live", "userData"));
  const handle = await attachToRenderer(config);
  await mcp.call("perf_trace_start", {});
  const start = Date.now();
  // Page times of each phase; offsets into the profile once its start is known.
  const pageMarks: Array<{ name: CollectionPhase; detail?: string; pageMs: number; time: string }> =
    [];
  const onPhase = async (name: CollectionPhase, detail?: string): Promise<void> => {
    const pageMs = (await handle.page
      .evaluate(
        `(() => { performance.mark(${JSON.stringify(`vortex-ai:${name}`)}); return performance.now(); })()`,
      )
      .catch(() => Number.NaN)) as number;
    pageMarks.push({ name, detail, pageMs, time: new Date().toISOString() });
  };
  const { result, summary, file, profile, pageStartMs } = await profileRenderer(
    handle.page,
    () => run(onPhase),
    { artifactDir: config.artifactDir, label, top: 15 },
  );
  const wallMs = Date.now() - start;
  const trace = await mcp.call<TraceSummary>("perf_trace_stop", { top: 40 });
  await handle.close();
  const marks: PhaseMark[] = pageMarks
    .filter((m) => Number.isFinite(m.pageMs))
    .map((m) => ({
      name: m.name,
      ...(m.detail === undefined ? {} : { detail: m.detail }),
      atMs: Math.round(m.pageMs - pageStartMs),
      time: m.time,
    }));
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
    closedWith: result.install.closedWith,
    postprocessed: result.install.postprocessed,
    ...(result.removeMs === undefined ? {} : { removeMs: result.removeMs }),
    dispatches: { dispatches: trace.dispatches, byCount: trace.byCount, byTime: trace.byTime },
    marks,
    hotFunctions: summary.functions,
    hotFiles: summary.files,
    inclusive: summary.inclusive,
    inclusiveApp: summary.inclusiveApp,
    longestBusy: summary.longestBusy,
    windows: summariseWindows(profile, windowsFromMarks(marks, summary.durationMs)),
    log: summariseLog(entries),
    cpuprofile: file,
  };
}

// A required member that already exists never fails; optional ones are skipped at the review
// unless --optionals says otherwise.
const installOptions: InstallCollectionOptions = {
  timeoutMs: 1_800_000,
  allowIncomplete: true,
  optionals: optionalsMode as InstallCollectionOptions["optionals"],
};
const install = await measure("collection-scale", async (onPhase) => ({
  install: await installOfflineCollection(mcp, archiveFor(1), { ...installOptions, onPhase }),
}));
const phases: Record<string, Phase> = { install };
if (update) {
  phases.update = await measure("collection-scale-update", (onPhase) =>
    updateOfflineCollection(mcp, install.collectionModId, archiveFor(2), {
      ...installOptions,
      onPhase,
    }),
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
  options: { ...options, update, optionals: optionalsMode },
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
  closedWith: phase.closedWith,
  postprocessed: phase.postprocessed,
  dispatches: phase.dispatches.dispatches,
  marks: phase.marks.map((m) => `${m.name}@${String(m.atMs)}ms`),
  top: phase.hotFunctions.slice(0, 5),
  topInclusive: phase.inclusiveApp.slice(0, 5),
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
