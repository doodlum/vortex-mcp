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

export interface ProfileSummary {
  durationMs: number;
  sampledMs: number;
  /** Functions by self time: `name (file:line)`. */
  functions: HotSpot[];
  /** Source files by the self time of everything in them. */
  files: HotSpot[];
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

  return {
    durationMs: Math.round((profile.endTime - profile.startTime) / 1000),
    sampledMs: Math.round(busyUs / 1000),
    functions: rank(functions),
    files: rank(files),
  };
}

export interface ProfileResult<T> {
  result: T;
  summary: ProfileSummary;
  /** Where the raw `.cpuprofile` was written, when an artifact directory was given. */
  file?: string;
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
  return { result, summary: summariseProfile(profile, options.top), file };
}
