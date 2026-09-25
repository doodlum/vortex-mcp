import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireLease, addInstancePid, checkoutResource, readLease, type LeaseEnv } from "./lease";
import { buildCheckout, buildEnvironment, restoreChanged, saveFiles } from "./vortexBuild";

let dir: string;
let checkout: string;
let env: LeaseEnv;
let alive: Set<number>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-build-test-"));
  checkout = path.join(dir, "vortex");
  fs.mkdirSync(path.join(checkout, "src", "main", "build"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "etc"), { recursive: true });
  fs.writeFileSync(
    path.join(checkout, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.10.0+sha512.abc" }),
  );
  fs.writeFileSync(path.join(checkout, "etc", "vortex.api.md"), "api v1\n");
  alive = new Set([process.pid, 4242]);
  env = { dir: path.join(dir, "leases"), isAlive: (pid) => alive.has(pid) };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the build environment", () => {
  it("sets NODE_ENV only for a production build and never passes the caller's on", () => {
    const caller = { PATH: "p", NODE_ENV: "development", Node_Env: "x", npm_config_x: "1" };
    expect(buildEnvironment(caller, true)).toEqual({ CI: "1", PATH: "p", NODE_ENV: "production" });
    expect(buildEnvironment(caller, false)).toEqual({ CI: "1", PATH: "p" });
  });

  it("puts back only the generated files the build changed", () => {
    const saved = saveFiles(checkout, ["etc/vortex.api.md", "etc/Dependency Report.md"]);
    fs.writeFileSync(path.join(checkout, "etc", "vortex.api.md"), "api v2\n");
    fs.writeFileSync(path.join(checkout, "etc", "Dependency Report.md"), "new\n");
    expect(restoreChanged(checkout, saved)).toEqual([
      "etc/vortex.api.md",
      "etc/Dependency Report.md",
    ]);
    expect(fs.readFileSync(path.join(checkout, "etc", "vortex.api.md"), "utf8")).toBe("api v1\n");
    expect(fs.existsSync(path.join(checkout, "etc", "Dependency Report.md"))).toBe(false);
    expect(restoreChanged(checkout, saved)).toEqual([]);
  });
});

const mustNotRun = async (): Promise<number> => {
  throw new Error("must not run");
};

describe("building a checkout", () => {
  it("runs the pinned pnpm under the checkout's lock and restores what the build rewrote", async () => {
    const runs: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const report = await buildCheckout({
      checkout,
      production: true,
      owner: "kit",
      installedPnpm: "9.15.0",
      leaseEnv: env,
      runner: async (command, args, options) => {
        runs.push({ command, args, env: options.env });
        // The build holds the lock while it runs.
        expect(readLease(checkoutResource(checkout), env)?.lease.owner).toBe("kit");
        fs.writeFileSync(path.join(checkout, "etc", "vortex.api.md"), "rewritten\n");
        return 0;
      },
    });
    expect(runs[0]?.command).toBe("pnpm");
    expect(runs[0]?.args).toEqual(["dlx", "pnpm@11.10.0", "run", "build"]);
    expect(runs[0]?.env.NODE_ENV).toBe("production");
    expect(report).toMatchObject({ exitCode: 0, restored: ["etc/vortex.api.md"] });
    expect(fs.readFileSync(path.join(checkout, "etc", "vortex.api.md"), "utf8")).toBe("api v1\n");
    // Released afterwards.
    expect(readLease(checkoutResource(checkout), env)).toBeUndefined();
  });

  it("uses the pnpm on PATH when it is the pinned version, and restores after a failed build", async () => {
    const report = await buildCheckout({
      checkout,
      production: false,
      installedPnpm: "11.10.0",
      leaseEnv: env,
      runner: async (_command, args, options) => {
        expect(args).toEqual(["run", "build"]);
        expect(options.env.NODE_ENV).toBeUndefined();
        fs.writeFileSync(path.join(checkout, "etc", "vortex.api.md"), "half\n");
        return 2;
      },
    });
    expect(report).toMatchObject({
      exitCode: 2,
      restored: ["etc/vortex.api.md"],
      nodeEnv: "unset",
    });
  });

  it("refuses while a Vortex runs from the checkout, and while another owner holds it", async () => {
    const resource = checkoutResource(checkout);
    acquireLease(resource, "kit", { ...env, pid: process.pid });
    addInstancePid(resource, 4242, env);
    await expect(
      buildCheckout({
        checkout,
        production: true,
        installedPnpm: "11.10.0",
        leaseEnv: env,
        runner: mustNotRun,
      }),
    ).rejects.toThrow(/is running from/);
    // That Vortex and its launcher exit; another owner then takes the checkout.
    alive.delete(4242);
    alive.delete(process.pid);
    alive.add(4243);
    acquireLease(resource, "someone", { ...env, pid: 4243 });
    alive.add(process.pid);
    await expect(
      buildCheckout({
        checkout,
        production: true,
        owner: "kit",
        installedPnpm: "11.10.0",
        leaseEnv: env,
        runner: mustNotRun,
      }),
    ).rejects.toThrow(/held by "someone"/);
  });

  it("refuses a directory that is not a Vortex checkout", async () => {
    await expect(buildCheckout({ checkout: dir, production: true, leaseEnv: env })).rejects.toThrow(
      /not a Vortex checkout/,
    );
  });
});
