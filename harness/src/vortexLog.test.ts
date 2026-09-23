import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { markLog, parseLogLine, readSince, summariseLog } from "./vortexLog";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Real lines, as Vortex writes them.
const LINES = [
  '2026-09-23T20:22:03.474Z [DEBG] [MAIN] Received persist:diff {"hive":"persistent","operationCount":3}',
  '2026-09-23T20:22:03.753Z [DEBG] [MAIN] Received persist:diff {"hive":"settings","operationCount":1}',
  '2026-09-23T20:22:04.000Z [WARN] [MAIN] level_pivot slow Write {"method":"bulkSetItem","alias":"db","count":1,"elapsedMs":43000}',
  '2026-09-23T20:11:43.752Z [INFO] [RENDERER] sorting mods {"modCount":4208}',
  '2026-09-23T20:11:52.154Z [INFO] [RENDERER] done sorting mods {"elapsed":8.4,"numRules":4526}',
  '2026-09-23T21:11:22.826Z [INFO] [RENDERER] state backup created {"ms":68130,"size":158847246}',
  '2026-09-23T21:11:23.000Z [WARN] [RENDERER] High memory usage {"usage":3327132,"max":4292608}',
  '2026-09-23T21:11:24.000Z [ERRO] [MAIN] render process gone {"exitCode":-536870904,"reason":"oom"}',
  "not a log line",
];

describe("parseLogLine", () => {
  it("splits level, process, message and trailing JSON", () => {
    expect(parseLogLine(LINES[3] ?? "")).toEqual({
      time: "2026-09-23T20:11:43.752Z",
      level: "INFO",
      process: "RENDERER",
      message: "sorting mods",
      data: { modCount: 4208 },
    });
  });
  it("keeps a message whose braces are not JSON", () => {
    const entry = parseLogLine("2026-09-23T00:00:00.000Z [INFO] [MAIN] set {not json}");
    expect(entry?.message).toBe("set {not json}");
    expect(entry?.data).toBeUndefined();
  });
});

describe("summariseLog", () => {
  it("reduces the main-process signals", () => {
    const entries = LINES.map(parseLogLine).filter((e) => e !== undefined);
    const summary = summariseLog(entries);
    expect(summary.lines).toBe(8);
    expect(summary.errors).toBe(1);
    expect(summary.persistDiffs).toEqual({
      count: 2,
      operations: 4,
      byHive: { persistent: 1, settings: 1 },
    });
    expect(summary.slowWrites).toEqual({ count: 1, totalMs: 43000, maxMs: 43000 });
    expect(summary.modSorts).toEqual({ count: 1, totalMs: 8400, maxMs: 8400, maxModCount: 4208 });
    expect(summary.stateBackups.maxMs).toBe(68130);
    expect(summary.stateBackups.maxSizeMb).toBe(151);
    expect(summary.memoryWarnings).toBe(1);
    expect(summary.rendererGone).toEqual(["oom"]);
  });
});

describe("markLog / readSince", () => {
  it("returns only what was written after the mark", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-log-"));
    dirs.push(dir);
    const file = path.join(dir, "vortex.log");
    fs.writeFileSync(file, `${LINES[0] ?? ""}\n`);
    const mark = markLog(dir);
    fs.appendFileSync(file, `${LINES[3] ?? ""}\n`);
    expect(readSince(mark).map((e) => e.message)).toEqual(["sorting mods"]);
  });

  it("reads the whole file again when it was replaced by a shorter one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-log-"));
    dirs.push(dir);
    const file = path.join(dir, "vortex.log");
    fs.writeFileSync(file, `${LINES.slice(0, 6).join("\n")}\n`);
    const mark = markLog(dir);
    fs.writeFileSync(file, `${LINES[3] ?? ""}\n`);
    expect(readSince(mark)).toHaveLength(1);
  });
});
