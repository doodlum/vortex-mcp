/**
 * CPU profiles of the Vortex renderer, over CDP, with no change to Vortex.
 *
 * The extension's perf tracer says *which* state changes were expensive. A profile says
 * *where the time went*: the functions and the source files that were on the CPU. That
 * is what turns "installs freeze the UI" into "a quadratic rule scan in
 * InstallManager" — evidence a fix can be aimed at, and re-measured against.
 *
 * Profiles are saved as `.cpuprofile`, which Chrome DevTools opens directly
 * (Performance panel → Load profile), next to a self-time summary.
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

/** The subset of the V8 CPU profile format this reads. */
export interface CpuProfile {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }>;
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface HotSpot {
  name: string;
  selfMs: number;
  percent: number;
}

export interface InclusiveSpot {
  name: string;
  /** Time with this function anywhere on the stack: itself and everything it called. */
  inclusiveMs: number;
  selfMs: number;
  /** Inclusive time as a share of the busy time summarised. */
  percent: number;
}

export interface BusyStretch {
  /** From the profile's start. */
  startMs: number;
  ms: number;
  /** Functions by inclusive time within the stretch, dependencies (node_modules) left out. */
  top: InclusiveSpot[];
}

export interface ProfileWindow {
  name: string;
  startMs: number;
  endMs: number;
  busyMs: number;
  /** Functions by inclusive time within the window, dependencies left out. */
  top: InclusiveSpot[];
  longestBusy: BusyStretch | null;
}

export interface ProfileSummary {
  durationMs: number;
  sampledMs: number;
  /** Functions by self time: `name (file:line)`. */
  functions: HotSpot[];
  /** Source files by the self time of everything in them. */
  files: HotSpot[];
  /** Named functions by inclusive time, dependencies included (React's work loop tops it). */
  inclusive: InclusiveSpot[];
  /** The same without node_modules and native frames: the app's own call tree. */
  inclusiveApp: InclusiveSpot[];
  /** The longest run of samples with no idle between them: the longest freeze, and why. */
  longestBusy: BusyStretch | null;
}

const IDLE = new Set(["(idle)", "(program)", "(garbage collector)"]);

/** Shorten a bundle or source URL to something readable in a report. */
export function shortUrl(url: string): string {
  if (url === "") return "(native)";
  const clean = url.replace(/^file:\/\/\/?/, "").replace(/\\/g, "/");
  const nodeModules = clean.lastIndexOf("node_modules/");
  if (nodeModules !== -1) return clean.slice(nodeModules);
  const parts = clean.split("/");
  return parts.slice(-3).join("/");
}

/**
 * Self time per function and per file. Idle and GC time is reported by the V8
 * pseudo-frames of the same name and is excluded from the percentages, except
 * garbage collection, which is kept as its own entry because it is real work.
 */
export function summariseProfile(profile: CpuProfile, top = 20): ProfileSummary {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    if (id === undefined) continue;
    // A sample's delta is the time since the previous one; attribute the *next* delta
    // to this sample, which is what DevTools does.
    const us = deltas[i + 1] ?? 0;
    selfUs.set(id, (selfUs.get(id) ?? 0) + us);
  }

  const functions = new Map<string, number>();
  const files = new Map<string, number>();
  let busyUs = 0;
  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (node === undefined) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    if (IDLE.has(functionName) && functionName !== "(garbage collector)") continue;
    busyUs += us;
    const file = functionName === "(garbage collector)" ? "(garbage collector)" : shortUrl(url);
    const name =
      functionName === "(garbage collector)"
        ? functionName
        : `${functionName || "(anonymous)"} (${file}:${String(lineNumber + 1)})`;
    functions.set(name, (functions.get(name) ?? 0) + us);
    files.set(file, (files.get(file) ?? 0) + us);
  }

  const rank = (entries: Map<string, number>): HotSpot[] =>
    [...entries]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, us]) => ({
        name,
        selfMs: Math.round(us / 100) / 10,
        percent: busyUs === 0 ? 0 : Math.round((us / busyUs) * 1000) / 10,
      }));

  const indexed = indexProfile(profile);
  const all = allSamples(indexed);
  return {
    durationMs: Math.round((profile.endTime - profile.startTime) / 1000),
    sampledMs: Math.round(busyUs / 1000),
    functions: rank(functions),
    files: rank(files),
    inclusive: inclusiveRank(indexed, all, top, false),
    inclusiveApp: inclusiveRank(indexed, all, top, true),
    longestBusy: longestBusy(indexed, all, top),
  };
}

// ---------------------------------------------------------------------------
// Inclusive time, busy stretches and windows
// ---------------------------------------------------------------------------

type ProfileNode = CpuProfile["nodes"][number];

interface IndexedProfile {
  profile: CpuProfile;
  byId: Map<number, ProfileNode>;
  parent: Map<number, number>;
  /** Microseconds from the profile's start at which each sample was taken. */
  at: number[];
  /** Microseconds charged to each sample (the delta after it, as DevTools does). */
  weight: number[];
  stacks: Map<number, ProfileNode[]>;
}

function indexProfile(profile: CpuProfile): IndexedProfile {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const at: number[] = [];
  const weight: number[] = [];
  let t = 0;
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] ?? 0;
    at.push(t);
    weight.push(deltas[i + 1] ?? 0);
  }
  return { profile, byId, parent, at, weight, stacks: new Map() };
}

/** Leaf first. */
function stackOf(p: IndexedProfile, id: number): ProfileNode[] {
  let stack = p.stacks.get(id);
  if (stack === undefined) {
    stack = [];
    let current: number | undefined = id;
    while (current !== undefined) {
      const node = p.byId.get(current);
      if (node === undefined) break;
      stack.push(node);
      current = p.parent.get(current);
    }
    p.stacks.set(id, stack);
  }
  return stack;
}

const allSamples = (p: IndexedProfile): number[] => p.at.map((_, i) => i);

const leafName = (p: IndexedProfile, i: number): string =>
  p.byId.get(p.profile.samples?.[i] ?? -1)?.callFrame.functionName ?? "(idle)";

/** Busy: anything but the idle pseudo-frame. `(program)` (layout, style, native) counts. */
const isBusy = (p: IndexedProfile, i: number): boolean => leafName(p, i) !== "(idle)";

function frameKey(node: ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;
  return `${functionName} (${shortUrl(url)}:${String(lineNumber + 1)})`;
}

function inclusiveRank(
  p: IndexedProfile,
  samples: number[],
  top: number,
  appOnly: boolean,
): InclusiveSpot[] {
  const inclusive = new Map<string, number>();
  const self = new Map<string, number>();
  let busy = 0;
  for (const i of samples) {
    if (!isBusy(p, i)) continue;
    const us = p.weight[i] ?? 0;
    busy += us;
    const stack = stackOf(p, p.profile.samples?.[i] ?? -1);
    const seen = new Set<string>();
    stack.forEach((node, depth) => {
      const { functionName, url } = node.callFrame;
      const gc = functionName === "(garbage collector)";
      // Anonymous functions and V8's pseudo-frames say nothing about where the time went.
      if (!gc && (functionName === "" || functionName.startsWith("("))) return;
      // The app's own tree: no dependencies, no native frames, and not this kit's extension,
      // whose dispatch wrapper (perf_trace) would otherwise top every inclusive list.
      const foreign = url === "" || url.includes("node_modules") || url.includes("vortex-mcp");
      if (appOnly && (gc || foreign)) return;
      const key = gc ? functionName : frameKey(node);
      if (depth === 0) self.set(key, (self.get(key) ?? 0) + us);
      // Recursion: count a function once per sample.
      if (seen.has(key)) return;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + us);
    });
  }
  return [...inclusive]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([name, us]) => ({
      name,
      inclusiveMs: Math.round(us / 100) / 10,
      selfMs: Math.round((self.get(name) ?? 0) / 100) / 10,
      percent: busy === 0 ? 0 : Math.round((us / busy) * 1000) / 10,
    }));
}

function longestBusy(p: IndexedProfile, samples: number[], top: number): BusyStretch | null {
  let best: { from: number; to: number; us: number } | undefined;
  let from = -1;
  let us = 0;
  let previous = -2;
  const close = (): void => {
    if (from >= 0 && (best === undefined || us > best.us)) best = { from, to: previous, us };
    from = -1;
    us = 0;
  };
  for (const i of samples) {
    // An idle sample ends a stretch, and so does a gap in the list (a window's edge).
    if (i !== previous + 1) close();
    if (isBusy(p, i)) {
      if (from < 0) from = i;
      us += p.weight[i] ?? 0;
    } else {
      close();
    }
    previous = i;
  }
  close();
  const found = best;
  if (found === undefined) return null;
  const stretch = samples.filter((i) => i >= found.from && i <= found.to);
  return {
    startMs: Math.round((p.at[found.from] ?? 0) / 1000),
    ms: Math.round(found.us / 1000),
    top: inclusiveRank(p, stretch, top, true),
  };
}

export interface WindowSpec {
  name: string;
  /** From the profile's start. */
  startMs: number;
  endMs: number;
}

/**
 * Summarise named stretches of a profile, for example between the marks a check recorded:
 * busy time, the app's functions by inclusive time, and the longest freeze in each.
 */
export function summariseWindows(
  profile: CpuProfile,
  windows: WindowSpec[],
  top = 10,
): ProfileWindow[] {
  const p = indexProfile(profile);
  return windows.map((w) => {
    const samples = allSamples(p).filter((i) => {
      const ms = (p.at[i] ?? 0) / 1000;
      return ms >= w.startMs && ms < w.endMs;
    });
    const busyUs = samples
      .filter((i) => isBusy(p, i))
      .reduce((sum, i) => sum + (p.weight[i] ?? 0), 0);
    return {
      name: w.name,
      startMs: Math.round(w.startMs),
      endMs: Math.round(w.endMs),
      busyMs: Math.round(busyUs / 1000),
      top: inclusiveRank(p, samples, top, true),
      longestBusy: longestBusy(p, samples, top),
    };
  });
}

export interface ProfileMark {
  name: string;
  /** Milliseconds from the profile's start. */
  atMs: number;
}

/** Windows between consecutive marks, from the profile's start to its end. */
export function windowsFromMarks(marks: ProfileMark[], durationMs: number): WindowSpec[] {
  const sorted = marks.toSorted((a, b) => a.atMs - b.atMs);
  const edges = [{ name: "start", atMs: 0 }, ...sorted];
  return edges.map((edge, i) => ({
    name: `${edge.name} -> ${sorted[i]?.name ?? "end"}`,
    startMs: edge.atMs,
    endMs: sorted[i]?.atMs ?? durationMs,
  }));
}

export interface ProfileResult<T> {
  result: T;
  summary: ProfileSummary;
  /** Where the raw `.cpuprofile` was written, when an artifact directory was given. */
  file?: string;
  /** The raw profile, for `summariseWindows`. */
  profile: CpuProfile;
  /**
   * The page's `performance.now()` just after the profiler started. A time the page records
   * later (a mark) minus this is its offset from the profile's start, to within the latency of
   * one evaluate.
   */
  pageStartMs: number;
}

/**
 * Profile the renderer while `run` executes, then summarise and optionally save it.
 * The profiler is stopped even when `run` throws.
 */
export async function profileRenderer<T>(
  page: Page,
  run: () => Promise<T>,
  options: { samplingIntervalUs?: number; artifactDir?: string; label?: string; top?: number } = {},
): Promise<ProfileResult<T>> {
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", {
    interval: options.samplingIntervalUs ?? 1_000,
  });
  await session.send("Profiler.start");
  const pageStartMs = (await page.evaluate("performance.now()")) as number;
  let result: T;
  let profile: CpuProfile;
  try {
    result = await run();
  } finally {
    profile = ((await session.send("Profiler.stop")) as unknown as { profile: CpuProfile }).profile;
    await session.send("Profiler.disable").catch(() => undefined);
    await session.detach().catch(() => undefined);
  }

  let file: string | undefined;
  if (options.artifactDir !== undefined) {
    fs.mkdirSync(options.artifactDir, { recursive: true });
    file = path.join(
      options.artifactDir,
      `${options.label ?? "renderer"}-${String(Date.now())}.cpuprofile`,
    );
    fs.writeFileSync(file, JSON.stringify(profile));
  }
  return { result, summary: summariseProfile(profile, options.top), file, profile, pageStartMs };
}
