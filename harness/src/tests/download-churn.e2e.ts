/**
 * Opt-in measurement of what concurrent downloads cost Vortex: pnpm run ai:test:download-churn.
 *
 * LAZ-1168: during large collection installs, persistence ran constantly on tiny diffs —
 * download progress and speed land in the persisted `persistent.downloads` hive — and the
 * main process's state database stalled behind them. This downloads throttled files from a
 * local server (no network, no account) and reports, for the span of the downloads:
 * persistence diffs per minute and per hive (from Vortex's log), the Redux dispatches that
 * drove them (from the perf tracer), renderer long tasks, and slow state-database writes.
 *
 * A measurement, not a pass/fail check: it prints the numbers and saves them as evidence.
 *
 *   --downloads <n>   concurrent downloads (default 4)
 *   --seconds <n>     how long each takes (default 60)
 */
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../config";
import { claimInstanceLease } from "../instance";
import { startDownloadServer } from "../downloadServer";
import { VortexMcpClient } from "../mcpClient";
import { markLog, readSince, summariseLog } from "../vortexLog";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const downloads = Number(flag("downloads") ?? 4);
const seconds = Number(flag("seconds") ?? 60);
const bytesPerSecond = 512 * 1024;

const config = loadConfig();
// Drives the running instance: refuse while another owner holds it.
claimInstanceLease(config, "ai:test:download-churn");
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
const status = await mcp.call<{ userDataDir: string | null }>("automation_status");
if (status.userDataDir === null) throw new Error("Run this against a harness instance.");

const server = await startDownloadServer({ sizeBytes: bytesPerSecond * seconds, bytesPerSecond });
const mark = markLog(status.userDataDir);
await mcp.call("perf_trace_start", {});
const start = Date.now();
try {
  const stamp = String(Date.now());
  const results = await Promise.all(
    Array.from({ length: downloads }, (_, i) => {
      // Vortex validates these arguments: the file name must be a string.
      const name = `churn-${stamp}-${String(i)}.zip`;
      return mcp.call(
        "vortex_dispatch",
        { action: "start-download", args: [[server.url(name)], {}, name, "__CALLBACK__"] },
        (seconds + 120) * 1000,
      );
    }),
  );
  const wallMs = Date.now() - start;
  const trace = await mcp.call<{
    dispatches: { count: number; totalMs: number };
    byCount: Array<{ type: string; count: number; totalMs: number }>;
    longTasks: { count: number; totalMs: number; maxMs: number };
  }>("perf_trace_stop", { top: 12 });
  const log = summariseLog(readSince(mark));
  const minutes = wallMs / 60_000;
  const report = {
    downloads,
    seconds,
    wallMs,
    downloadIds: results,
    persistDiffs: {
      ...log.persistDiffs,
      perMinute: Math.round(log.persistDiffs.count / minutes),
    },
    slowWrites: log.slowWrites,
    dispatches: trace.dispatches,
    busiestActions: trace.byCount.slice(0, 8),
    longTasks: trace.longTasks,
  };
  fs.mkdirSync(config.artifactDir, { recursive: true });
  const file = path.join(config.artifactDir, `download-churn-${String(Date.now())}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`evidence: ${file}`);
} finally {
  await server.close();
}
