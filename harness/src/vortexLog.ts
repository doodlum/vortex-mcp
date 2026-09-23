/**
 * Timings Vortex already writes to its own log, read back for a window of activity.
 *
 * The renderer can be traced from an extension and profiled over CDP, but the main
 * process — where persistence and downloads run — cannot, on a stock build. Vortex
 * does log the main-process events that matter for the large-collection reports,
 * with durations: persistence diffs arriving from the renderer, slow state-database
 * writes, mod sorts, state backups, memory warnings, renderer crashes. Reading them
 * for exactly the span of a measured operation gives main-process evidence without
 * touching Vortex.
 */
import fs from "node:fs";
import path from "node:path";

export interface LogEntry {
  time: string;
  level: string;
  process: string;
  message: string;
  data: Record<string, unknown> | undefined;
}

const LINE = /^(\S+) \[(\w+)\] \[(\w+)\] (.*)$/;

/** Parse one vortex.log line; the trailing JSON object, when present, becomes `data`. */
export function parseLogLine(line: string): LogEntry | undefined {
  const match = LINE.exec(line.trimEnd());
  if (match === null) return undefined;
  const [, time = "", level = "", proc = "", rest = ""] = match;
  const brace = rest.indexOf(" {");
  let message = rest;
  let data: Record<string, unknown> | undefined;
  if (brace !== -1 && rest.endsWith("}")) {
    try {
      data = JSON.parse(rest.slice(brace + 1)) as Record<string, unknown>;
      message = rest.slice(0, brace);
    } catch {
      data = undefined;
    }
  }
  return { time, level, process: proc, message, data };
}

/** A position in the log to read on from, so a measurement sees only its own lines. */
export interface LogMark {
  file: string;
  offset: number;
}

export function markLog(userDataDir: string): LogMark {
  const file = path.join(userDataDir, "vortex.log");
  return { file, offset: fs.existsSync(file) ? fs.statSync(file).size : 0 };
}

/**
 * Entries written since `mark`. Vortex rotates the log at startup, not while running,
 * so a mark stays valid for the life of an instance; if the file shrank anyway the
 * whole current file is read.
 */
export function readSince(mark: LogMark): LogEntry[] {
  if (!fs.existsSync(mark.file)) return [];
  const size = fs.statSync(mark.file).size;
  const start = size < mark.offset ? 0 : mark.offset;
  const fd = fs.openSync(mark.file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer
      .toString("utf8")
      .split(/\r?\n/)
      .map(parseLogLine)
      .filter((e): e is LogEntry => e !== undefined);
  } finally {
    fs.closeSync(fd);
  }
}

export interface Timed {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface LogSummary {
  lines: number;
  errors: number;
  persistDiffs: { count: number; operations: number; byHive: Record<string, number> };
  slowWrites: Timed;
  modSorts: Timed & { maxModCount: number };
  stateBackups: Timed & { maxSizeMb: number };
  memoryWarnings: number;
  rendererGone: string[];
}

const timed = (): Timed => ({ count: 0, totalMs: 0, maxMs: 0 });
const add = (t: Timed, ms: number): void => {
  t.count += 1;
  t.totalMs += ms;
  t.maxMs = Math.max(t.maxMs, ms);
};
const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/** Reduce entries to the main-process signals the large-library reports are about. */
export function summariseLog(entries: LogEntry[]): LogSummary {
  const summary: LogSummary = {
    lines: entries.length,
    errors: 0,
    persistDiffs: { count: 0, operations: 0, byHive: {} },
    slowWrites: timed(),
    modSorts: { ...timed(), maxModCount: 0 },
    stateBackups: { ...timed(), maxSizeMb: 0 },
    memoryWarnings: 0,
    rendererGone: [],
  };
  for (const entry of entries) {
    const { message, data } = entry;
    if (entry.level === "ERRO") summary.errors += 1;
    if (message === "Received persist:diff") {
      summary.persistDiffs.count += 1;
      summary.persistDiffs.operations += num(data?.operationCount);
      const hive = String(data?.hive ?? "?");
      summary.persistDiffs.byHive[hive] = (summary.persistDiffs.byHive[hive] ?? 0) + 1;
    } else if (/slow write/i.test(message)) {
      // "level_pivot slow Write {method, alias, count, elapsedMs}", past 250ms.
      add(summary.slowWrites, num(data?.elapsedMs));
    } else if (message === "done sorting mods") {
      // Vortex logs this one in seconds.
      add(summary.modSorts, num(data?.elapsed) * 1000);
    } else if (message === "sorting mods") {
      summary.modSorts.maxModCount = Math.max(summary.modSorts.maxModCount, num(data?.modCount));
    } else if (message === "state backup created") {
      add(summary.stateBackups, num(data?.ms));
      summary.stateBackups.maxSizeMb = Math.max(
        summary.stateBackups.maxSizeMb,
        Math.round(num(data?.size) / (1024 * 1024)),
      );
    } else if (/high memory usage|using a lot of memory/i.test(message)) {
      summary.memoryWarnings += 1;
    } else if (message === "render process gone") {
      summary.rendererGone.push(String(data?.reason ?? "unknown"));
    }
  }
  return summary;
}
