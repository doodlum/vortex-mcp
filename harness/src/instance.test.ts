import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type HarnessConfig } from "./config";
import {
  attachedLeaseResources,
  buildInstanceEnv,
  claimInstanceLease,
  forgetLaunchedPid,
  instanceLeaseResources,
  recordLaunchedPid,
} from "./instance";
import {
  INSTANCE_RESOURCE,
  LeaseHeldError,
  acquireLease,
  checkoutResource,
  readLease,
  type LeaseEnv,
} from "./lease";

let dir: string;
let checkout: string;
let alive: Set<number>;
let env: LeaseEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-instance-test-"));
  checkout = path.join(dir, "vx-ab");
  fs.mkdirSync(checkout);
  alive = new Set([process.pid, 1001, 1002, 4242]);
  env = { dir: path.join(dir, "leases"), isAlive: (pid) => alive.has(pid) };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function devConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return loadConfig({
    target: {
      kind: "dev",
      executable: path.join(checkout, "electron.exe"),
      args: [path.join(checkout, "src", "main")],
      appName: "@vortex/main",
      sourceDir: checkout,
    },
    cacheDir: path.join(dir, "cache"),
    owner: "kit-agent2",
    ...overrides,
  });
}

function installedConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return loadConfig({
    target: { kind: "installed", executable: "Vortex.exe", args: [], appName: "Vortex" },
    cacheDir: path.join(dir, "cache"),
    ...overrides,
  });
}

describe("buildInstanceEnv", () => {
  it("launches a --production source build with NODE_ENV=production, not without one", () => {
    // A plain `pnpm run build` inlines "development" into main.cjs, so main never sets
    // production itself; deleting NODE_ENV left the renderer on React's development build.
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(buildInstanceEnv(dir, devConfig({ production: true })).NODE_ENV).toBe("production");
      expect(buildInstanceEnv(dir, devConfig({ production: false })).NODE_ENV).toBe("development");
      process.env.NODE_ENV = "development";
      expect(buildInstanceEnv(dir, devConfig({ production: true })).NODE_ENV).toBe("production");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("leaves a released build's NODE_ENV alone", () => {
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(buildInstanceEnv(dir, installedConfig({ production: true })).NODE_ENV).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.NODE_ENV = previous;
    }
  });

  it("keeps the API key out of Vortex's environment unless it is in use", () => {
    const saved = {
      a: process.env.VORTEX_AI_NEXUS_API_KEY,
      b: process.env.NEXUS_API_KEY,
    };
    process.env.VORTEX_AI_NEXUS_API_KEY = "secret-from-harness-env";
    process.env.NEXUS_API_KEY = "secret-too";
    try {
      // A sandbox run withholds the key (localOnlyConfig); harness/.env still loaded it.
      const withheld = buildInstanceEnv(
        dir,
        devConfig({ apiKey: undefined, apiKeyWithheld: true }),
      );
      expect(withheld.VORTEX_AI_NEXUS_API_KEY).toBeUndefined();
      expect(withheld.NEXUS_API_KEY).toBeUndefined();
      expect(Object.values(withheld)).not.toContain("secret-from-harness-env");
      // --with-api-key (or a non-sandbox run) keeps it.
      const kept = buildInstanceEnv(dir, devConfig({ apiKey: "secret-from-harness-env" }));
      expect(kept.VORTEX_AI_NEXUS_API_KEY).toBe("secret-from-harness-env");
    } finally {
      for (const [key, value] of [
        ["VORTEX_AI_NEXUS_API_KEY", saved.a],
        ["NEXUS_API_KEY", saved.b],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("the leases a running Vortex needs", () => {
  it("are the instance alone for a released build, and the checkout too for a source build", () => {
    expect(instanceLeaseResources(installedConfig())).toEqual([INSTANCE_RESOURCE]);
    expect(instanceLeaseResources(devConfig())).toEqual([
      INSTANCE_RESOURCE,
      checkoutResource(checkout),
    ]);
  });

  it("refuse a launch from a checkout another owner has locked, holding nothing", () => {
    // The observed hole: one agent rebuilt vx-ab while another ran Vortex from it.
    acquireLease(checkoutResource(checkout), "rebuilder", { ...env, pid: 1001 });
    expect(() => claimInstanceLease(devConfig(), "launch Vortex", env)).toThrow(LeaseHeldError);
    // The instance it took first was given back.
    expect(readLease(INSTANCE_RESOURCE, env)).toBeUndefined();
  });

  it("lock the checkout while Vortex runs from it, after the launching command exits", () => {
    const config = devConfig();
    const hold = claimInstanceLease(config, "launch Vortex", env);
    recordLaunchedPid(config, 4242, env);
    hold.release();
    // `up` has exited; its Vortex still holds both.
    for (const resource of [INSTANCE_RESOURCE, checkoutResource(checkout)]) {
      expect(readLease(resource, env)).toMatchObject({
        live: true,
        lease: { owner: "kit-agent2" },
      });
    }
    expect(() =>
      acquireLease(checkoutResource(checkout), "rebuilder", { ...env, pid: 1002 }),
    ).toThrow(/held by "kit-agent2"/);
    forgetLaunchedPid(config, 4242, env);
    expect(readLease(checkoutResource(checkout), env)).toBeUndefined();
    expect(readLease(INSTANCE_RESOURCE, env)).toBeUndefined();
  });

  it("for a command attaching to a running Vortex, are its checkout, not the configured one", () => {
    const config = installedConfig();
    expect(attachedLeaseResources(config)).toEqual([INSTANCE_RESOURCE]);
    // Written by the launch: this process stands in for the running Vortex.
    fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(config.cacheDir, "instance.json"),
      JSON.stringify({ pid: process.pid, sourceDir: checkout }),
    );
    expect(attachedLeaseResources(config)).toEqual([INSTANCE_RESOURCE, checkoutResource(checkout)]);
    acquireLease(checkoutResource(checkout), "rebuilder", { ...env, pid: 1001 });
    expect(() =>
      claimInstanceLease(config, "ai:test:collection-scale", env, { attach: true }),
    ).toThrow(LeaseHeldError);
    // A Vortex that has exited no longer ties the command to its checkout.
    fs.writeFileSync(
      path.join(config.cacheDir, "instance.json"),
      JSON.stringify({ pid: 2 ** 30, sourceDir: checkout }),
    );
    expect(attachedLeaseResources(config)).toEqual([INSTANCE_RESOURCE]);
  });

  it("join a checkout lock the same owner already holds, and take the instance with it", () => {
    acquireLease(checkoutResource(checkout), "kit-agent2", {
      ...env,
      mode: "explicit",
      ttlMinutes: 60,
    });
    const hold = claimInstanceLease(devConfig(), "launch Vortex", env);
    expect(hold.joined).toBe(false);
    expect(readLease(INSTANCE_RESOURCE, env)?.lease.owner).toBe("kit-agent2");
    // A second owner is now refused the instance as well as the checkout.
    expect(() => claimInstanceLease(devConfig({ owner: "other" }), "launch Vortex", env)).toThrow(
      LeaseHeldError,
    );
    hold.release();
    expect(readLease(checkoutResource(checkout), env)?.lease.mode).toBe("explicit");
  });
});
