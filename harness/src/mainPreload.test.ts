import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { preparePreload, verifyPreload } from "./mainPreload";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-preload-"));
  dirs.push(dir);
  return dir;
};

/**
 * Run the generated preload under plain Node with a stand-in `electron` module on the
 * require path, the way Electron's main process would load it.
 */
function runPreload(
  dir: string,
  nodeOptions: string,
  electron: string,
  processType = "browser",
): { status: number; nodeOptionsAfter: string } {
  const modules = path.join(dir, "node_modules", "electron");
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(modules, "index.js"), electron);
  // Electron sets process.type before any preload runs; an earlier --require stands in.
  const setType = path.join(dir, "set-type.cjs").replace(/\\/g, "/");
  fs.writeFileSync(setType, `process.type = ${JSON.stringify(processType)};`);
  // The app's entry point, which loads electron the way Vortex's main does.
  const probe = path.join(dir, "probe.cjs");
  fs.writeFileSync(
    probe,
    "require('electron'); process.stdout.write(process.env.NODE_OPTIONS || '');",
  );
  try {
    const out = execFileSync(process.execPath, [probe], {
      cwd: dir,
      env: { ...process.env, NODE_OPTIONS: `--require "${setType}" ${nodeOptions}` },
      encoding: "utf8",
    });
    return { status: 0, nodeOptionsAfter: out };
  } catch (err) {
    return { status: (err as { status: number }).status, nodeOptionsAfter: "" };
  }
}

const workingElectron = `const paths = {};
module.exports = { app: { setPath: (n, v) => { paths[n] = v; }, getPath: (n) => paths[n] } };`;

describe("the path-redirect preload", () => {
  it("sets each path, records what Electron reports, and leaves nothing for children", async () => {
    const dir = tempDir();
    const preload = preparePreload(dir, { documents: "C:\\sandbox\\Documents" });
    const run = runPreload(dir, preload.nodeOptions, workingElectron);
    expect(run.status).toBe(0);
    // Only the stand-in's own --require is left for child processes.
    expect(run.nodeOptionsAfter).not.toContain("redirect-paths");
    const record = await verifyPreload(preload.recordFile, { documents: "C:\\sandbox\\Documents" });
    expect(record.paths.documents).toBe("C:\\sandbox\\Documents");
  });

  it("exits rather than let Vortex start when a path cannot be set", async () => {
    const dir = tempDir();
    const preload = preparePreload(dir, { documents: "C:\\sandbox\\Documents" });
    const failing = `module.exports = { app: { setPath: () => { throw new Error("nope"); }, getPath: () => "" } };`;
    expect(runPreload(dir, preload.nodeOptions, failing).status).toBe(78);
    await expect(verifyPreload(preload.recordFile, { documents: "x" }, 1_000)).rejects.toThrow(
      /nope/,
    );
  });

  it("does nothing outside the main process", () => {
    const dir = tempDir();
    const preload = preparePreload(dir, { documents: "C:\\sandbox\\Documents" });
    expect(runPreload(dir, preload.nodeOptions, workingElectron, "renderer").status).toBe(0);
    expect(fs.existsSync(preload.recordFile)).toBe(false);
  });

  it("reports a build that never ran it", async () => {
    const dir = tempDir();
    const preload = preparePreload(dir, { documents: "C:\\sandbox\\Documents" });
    await expect(verifyPreload(preload.recordFile, { documents: "x" }, 200)).rejects.toThrow(
      /ignores NODE_OPTIONS/,
    );
  });

  it("rejects a record whose path is not the one asked for", async () => {
    const dir = tempDir();
    const preload = preparePreload(dir, { documents: "C:\\sandbox\\Documents" });
    fs.writeFileSync(
      preload.recordFile,
      JSON.stringify({ pid: 1, paths: { documents: "C:\\Users\\real\\Documents" } }),
    );
    await expect(
      verifyPreload(preload.recordFile, { documents: "C:\\sandbox\\Documents" }, 500),
    ).rejects.toThrow(/not C:\\sandbox\\Documents/);
  });
});
