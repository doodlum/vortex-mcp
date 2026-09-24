import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INSTANCE_RESOURCE, checkoutResource, readLease, type LeaseEnv } from "./lease";
import {
  accountsForTest,
  callEnd,
  compareRuns,
  configuredAccounts,
  credentialSkips,
  e2eExitCode,
  formatE2eReport,
  grepInvertFor,
  listedTests,
  outcomes,
  runVortexE2e,
  summarise,
  type FixturePatch,
  type PlaywrightInvocation,
  type PlaywrightJsonReport,
  type TestOutcome,
  type VortexE2eReport,
} from "./vortexE2e";

const SPEC = `import { test, expect } from "../fixtures/vortex-app";
import { freeUser, premiumUser } from "../helpers/users";

const TIERS = [
  { tier: "free", user: freeUser },
  { tier: "premium", user: premiumUser },
];

test.describe("Signed out", () => {
  test("shows the dashboard", async ({ vortexWindow }) => {
    // a comment with ) and { in it
    const s = "string with ( and }";
    expect(\`template \${s.length} with )\`).toBeTruthy();
  });
});

test.describe("Account", () => {
  // Nested first: its use must not be read as the outer describe's.
  test.describe("but logged out", () => {
    test.use({ nexusUser: null });
    test("override to signed out", async () => {});
  });
  test.use({ nexusUser: freeUser });
  test("free user logs in", async () => {});
});

test.describe("Tiers", () => {
  for (const { tier, user } of TIERS) {
    test.describe(tier, () => {
      test.use({ nexusUser: user });
      test(\`\${tier} user does NOT see the Premium badge\`, async () => {});
    });
  }
});

test.describe("Body reference", () => {
  test("logs in by hand", async ({ vortexWindow }) => {
    await login(vortexWindow, premiumUser);
  });
});
`;

/** Where each test() and test.describe() in SPEC is, as Playwright reports it. */
function locate(src: string, needle: string, occurrence = 0): { line: number; column: number } {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = src.indexOf(needle, at + 1);
  const before = src.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  // Playwright's column points at the callee's name: "describe" in test.describe, "test" in test.
  const callee = needle.startsWith("test.describe") ? column + "test.".length : column;
  return { line, column: callee };
}

function listing(): PlaywrightJsonReport {
  const d = (title: string, needle: string, occurrence = 0) => ({
    title,
    file: "a.spec.ts",
    ...locate(SPEC, needle, occurrence),
  });
  const spec = (title: string, needle: string) => ({
    title,
    file: "a.spec.ts",
    ...locate(SPEC, needle),
    tests: [{ projectName: "", status: "skipped", results: [] }],
  });
  return {
    config: { rootDir: "/unused" },
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        line: 0,
        column: 0,
        specs: [],
        suites: [
          {
            ...d("Signed out", 'test.describe("Signed out"'),
            specs: [spec("shows the dashboard", 'test("shows the dashboard"')],
          },
          {
            ...d("Account", 'test.describe("Account"'),
            specs: [spec("free user logs in", 'test("free user logs in"')],
            suites: [
              {
                ...d("but logged out", 'test.describe("but logged out"'),
                specs: [spec("override to signed out", 'test("override to signed out"')],
              },
            ],
          },
          {
            ...d("Tiers", 'test.describe("Tiers"'),
            specs: [],
            suites: ["free", "premium"].map((tier) => ({
              ...d(tier, "test.describe(tier"),
              specs: [spec(`${tier} user does NOT see the Premium badge`, "test(`${tier} user")],
            })),
          },
          {
            ...d("Body reference", 'test.describe("Body reference"'),
            specs: [spec("logs in by hand", 'test("logs in by hand"')],
          },
        ],
      },
    ],
  };
}

describe("credential-gated tests", () => {
  it("finds the account each test needs from test.use and its body", () => {
    const needs = Object.fromEntries(
      listedTests(listing()).map((t) => [t.titlePath.join(" > "), accountsForTest(SPEC, t)]),
    );
    expect(needs).toEqual({
      "Signed out > shows the dashboard": [],
      "Account > free user logs in": ["free"],
      "Account > but logged out > override to signed out": [],
      "Tiers > free > free user does NOT see the Premium badge": ["free"],
      "Tiers > premium > premium user does NOT see the Premium badge": ["premium"],
      "Body reference > logs in by hand": ["premium"],
    });
  });

  it("skips only the tests whose accounts are absent", () => {
    const tests = listedTests(listing());
    const skips = credentialSkips(tests, () => SPEC, { free: true, premium: false });
    expect(skips.map((s) => s.title)).toEqual([
      "Tiers > premium > premium user does NOT see the Premium badge",
      "Body reference > logs in by hand",
    ]);
  });

  it("builds a grep-invert that matches exactly the skipped tests", () => {
    const tests = listedTests(listing());
    const skipped = tests.filter((t) => t.titlePath.includes("Account"));
    const pattern = new RegExp(grepInvertFor(skipped) ?? "^$", "i");
    // What Playwright matches against: project, file, titles, tags.
    expect(tests.filter((t) => pattern.test(grepTitle(t))).map((t) => t.id)).toEqual(
      skipped.map((t) => t.id),
    );
    expect(grepInvertFor([])).toBeUndefined();
  });

  it("matches calls past strings, comments and template literals", () => {
    const src = 'f(a, ")", `(${"}"})`, /* ) */ { b: [1] }) // )\nrest';
    expect(src.slice(0, callEnd(src, 0))).toBe('f(a, ")", `(${"}"})`, /* ) */ { b: [1] })');
  });

  it("reads configured accounts from the environment and packages/e2e/.env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-e2e-env-"));
    try {
      fs.writeFileSync(
        path.join(dir, ".env"),
        "E2E_NEXUS_FREE_USER_USERNAME=u\nE2E_NEXUS_FREE_USER_PASSWORD=p\n",
      );
      expect(configuredAccounts(dir, {})).toEqual({ free: true, premium: false });
      expect(
        configuredAccounts(dir, {
          E2E_NEXUS_PREMIUM_USER_USERNAME: "u",
          E2E_NEXUS_PREMIUM_USER_PASSWORD: "",
        }),
      ).toEqual({ free: true, premium: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function grepTitle(t: { file: string; titlePath: string[] }): string {
  return [" ", t.file, ...t.titlePath].join(" ");
}

function result(status: string, last: string, message?: string) {
  return {
    projectName: "",
    status,
    results: [
      { status: last, duration: 1500, ...(message === undefined ? {} : { error: { message } }) },
    ],
  };
}

function outcome(id: string, status: TestOutcome["status"]): TestOutcome {
  return {
    id,
    file: "a.spec.ts",
    line: 1,
    title: id,
    status,
    error: status === "failed" ? `${id} broke` : undefined,
  };
}

function runReport(): PlaywrightJsonReport {
  const test = result;
  return {
    stats: { duration: 4200 },
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        line: 0,
        column: 0,
        specs: [],
        suites: [
          {
            title: "Suite",
            file: "a.spec.ts",
            line: 1,
            column: 6,
            specs: [
              {
                title: "passes",
                file: "a.spec.ts",
                line: 2,
                column: 3,
                tests: [test("expected", "passed")],
              },
              {
                title: "fails",
                file: "a.spec.ts",
                line: 3,
                column: 3,
                tests: [
                  test(
                    "unexpected",
                    "timedOut",
                    "\u001b[31mTest timeout of 360000ms exceeded.\u001b[39m\n\nstack",
                  ),
                ],
              },
              {
                title: "skips",
                file: "a.spec.ts",
                line: 4,
                column: 3,
                tests: [test("skipped", "skipped")],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("summary", () => {
  it("counts outcomes and keeps each failure's first error line", () => {
    const results = outcomes(runReport());
    const { counts, failures } = summarise(results, [
      { id: "x", file: "b.spec.ts", line: 1, title: "needs account", accounts: ["free"] },
    ]);
    expect(counts).toEqual({
      total: 4,
      passed: 1,
      failed: 1,
      skipped: 1,
      flaky: 0,
      credentialSkipped: 1,
    });
    expect(failures).toEqual([
      {
        id: "a.spec.ts :: Suite > fails",
        file: "a.spec.ts",
        line: 3,
        error: "Test timeout of 360000ms exceeded.",
      },
    ]);
  });
});

describe("compareRuns", () => {
  it("separates regressions from pre-existing failures", () => {
    const baseline = {
      headSha: "b".repeat(40),
      outcomes: [
        outcome("still-broken", "failed"),
        outcome("newly-broken", "passed"),
        outcome("fixed", "failed"),
        outcome("dropped", "passed"),
      ],
      credentialSkipped: [{ id: "was-skipped", file: "", line: 0, title: "", accounts: [] }],
    };
    const current = {
      outcomes: [
        outcome("still-broken", "failed"),
        outcome("newly-broken", "failed"),
        outcome("fixed", "passed"),
        outcome("brand-new", "failed"),
        outcome("was-skipped", "failed"),
      ],
      credentialSkipped: [],
    };
    const c = compareRuns(current, baseline, "base.json");
    expect(c.regressions).toEqual([
      { id: "newly-broken", error: "newly-broken broke", baseline: "passed" },
      { id: "brand-new", error: "brand-new broke", baseline: "absent" },
      { id: "was-skipped", error: "was-skipped broke", baseline: "credential-skipped" },
    ]);
    expect(c.preExisting).toEqual([{ id: "still-broken", error: "still-broken broke" }]);
    expect(c.fixed).toEqual(["fixed"]);
    expect(c.notRun).toEqual(["dropped"]);
  });
});

// ---------------------------------------------------------------------------
// The whole run against a temporary checkout, with a stub Playwright
// ---------------------------------------------------------------------------

const FIXTURE_BEFORE = "export function waitForMainWindow() {\n  return racy();\n}\n";
const FIXTURE_AFTER = "export function waitForMainWindow() {\n  return waitProperly();\n}\n";
const FIXTURE = "packages/e2e/src/fixtures/vortex-app.ts";

function run(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// Several git processes per test: slow on Windows, slower still beside the other suites.
describe("runVortexE2e", { timeout: 30_000 }, () => {
  let root: string;
  let checkout: string;
  let patch: FixturePatch;
  let leaseEnv: LeaseEnv;
  let artifactDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-e2e-run-"));
    checkout = path.join(root, "vortex");
    artifactDir = path.join(root, "artifacts");
    leaseEnv = { dir: path.join(root, "leases") };
    fs.mkdirSync(path.join(checkout, "packages", "e2e", "src", "fixtures"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "packages", "e2e", "src", "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, "packages", "e2e", "playwright.config.ts"),
      "export default {};\n",
    );
    fs.writeFileSync(path.join(checkout, FIXTURE), FIXTURE_BEFORE);
    fs.writeFileSync(path.join(checkout, "packages", "e2e", "src", "tests", "a.spec.ts"), SPEC);
    run(root, ["init", "-q", checkout]);
    run(checkout, ["config", "core.autocrlf", "false"]);
    run(checkout, ["add", "-A"]);
    run(checkout, [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    fs.writeFileSync(path.join(checkout, FIXTURE), FIXTURE_AFTER);
    const patchFile = path.join(root, "fix.patch");
    fs.writeFileSync(patchFile, run(checkout, ["diff", "--no-color"]));
    run(checkout, ["checkout", "--", FIXTURE]);
    patch = { id: "fix", file: patchFile, description: "test fix" };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Lists SPEC's tests; runs them with results, checking the fixture is patched meanwhile. */
  function stubRunner(seen: { fixtureDuringRun?: string; runArgs?: string[] }) {
    return async (invocation: PlaywrightInvocation): Promise<{ code: number }> => {
      const list = listing();
      list.config = { rootDir: path.join(invocation.cwd, "src", "tests") };
      if (invocation.list) {
        const invert = invocation.args[invocation.args.indexOf("--grep-invert") + 1];
        if (invocation.args.includes("--grep-invert") && invert !== undefined) {
          const re = new RegExp(invert, "i");
          const keep = (
            suite: NonNullable<PlaywrightJsonReport["suites"]>[number],
            titles: string[],
          ): typeof suite => ({
            ...suite,
            specs: (suite.specs ?? []).filter(
              (s) => !re.test(["", "", s.file, ...titles, s.title].join(" ")),
            ),
            suites: (suite.suites ?? []).map((c) => keep(c, [...titles, c.title])),
          });
          list.suites = (list.suites ?? []).map((f) => ({
            ...f,
            suites: (f.suites ?? []).map((c) => keep(c, [c.title])),
          }));
        }
        fs.writeFileSync(invocation.jsonFile, JSON.stringify(list));
        return { code: 0 };
      }
      seen.fixtureDuringRun = fs.readFileSync(
        path.join(invocation.cwd, "src", "fixtures", "vortex-app.ts"),
        "utf8",
      );
      seen.runArgs = invocation.args;
      expect(invocation.env.CI).toBe("1");
      expect(invocation.env.VORTEX_E2E_HEADED).toBeUndefined();
      fs.writeFileSync(invocation.jsonFile, JSON.stringify(runReport()));
      return { code: 1 };
    };
  }

  it("patches the fixture for the run only, leaves out absent accounts and reports", async () => {
    const saved = {
      free: process.env.E2E_NEXUS_FREE_USER_USERNAME,
      premium: process.env.E2E_NEXUS_PREMIUM_USER_USERNAME,
    };
    delete process.env.E2E_NEXUS_FREE_USER_USERNAME;
    delete process.env.E2E_NEXUS_PREMIUM_USER_USERNAME;
    const seen: { fixtureDuringRun?: string; runArgs?: string[] } = {};
    let report: VortexE2eReport;
    try {
      report = await runVortexE2e({
        checkout,
        artifactDir,
        owner: "qa",
        patches: [patch],
        runner: stubRunner(seen),
        leaseEnv,
        handleSignals: false,
      });
    } finally {
      if (saved.free !== undefined) process.env.E2E_NEXUS_FREE_USER_USERNAME = saved.free;
      if (saved.premium !== undefined) process.env.E2E_NEXUS_PREMIUM_USER_USERNAME = saved.premium;
    }

    expect(seen.fixtureDuringRun).toBe(FIXTURE_AFTER);
    expect(seen.runArgs).toEqual(
      expect.arrayContaining([
        "--workers=1",
        "--retries=0",
        "--reporter=list,json",
        "--grep-invert",
      ]),
    );
    // Restored byte-identically, tree clean, leases gone.
    expect(fs.readFileSync(path.join(checkout, FIXTURE), "utf8")).toBe(FIXTURE_BEFORE);
    expect(run(checkout, ["status", "--porcelain"]).trim()).toBe("");
    expect(readLease(INSTANCE_RESOURCE, leaseEnv)).toBeUndefined();
    expect(readLease(checkoutResource(checkout), leaseEnv)).toBeUndefined();

    expect(report.headSha).toBe(run(checkout, ["rev-parse", "HEAD"]).trim());
    expect(report.patches).toEqual([
      { id: "fix", files: [FIXTURE], applied: true, alreadyPresent: false, restored: true },
    ]);
    expect(report.counts).toMatchObject({ passed: 1, failed: 1, skipped: 1, credentialSkipped: 4 });
    expect(report.credentialSkipped.map((s) => s.accounts)).toEqual([
      ["free"],
      ["free"],
      ["premium"],
      ["premium"],
    ]);
    expect(e2eExitCode(report)).toBe(1);
    expect(report.reportFile).toBeDefined();
    expect(JSON.parse(fs.readFileSync(report.reportFile ?? "", "utf8"))).toMatchObject({
      tool: "vortex-e2e",
    });
    expect(formatE2eReport(report)).toContain(
      "1 passed, 1 failed, 1 skipped, 4 skipped for missing credentials",
    );
  });

  it("compares against a baseline that PowerShell saved with a byte-order mark", async () => {
    const options = {
      checkout,
      artifactDir,
      patches: [patch],
      runner: stubRunner({}),
      leaseEnv,
      handleSignals: false,
    };
    const first = await runVortexE2e(options);
    // `Out-File -Encoding utf8` in Windows PowerShell 5.1: a BOM, then the JSON.
    const baseline = path.join(root, "baseline.json");
    fs.writeFileSync(baseline, `﻿${fs.readFileSync(first.reportFile ?? "", "utf8")}`);
    const second = await runVortexE2e({ ...options, compare: baseline });
    expect(second.compare?.regressions).toEqual([]);
    expect(second.compare?.preExisting.length).toBeGreaterThan(0);
  });

  it("refuses to patch a fixture with uncommitted changes and leaves it alone", async () => {
    fs.writeFileSync(path.join(checkout, FIXTURE), `${FIXTURE_BEFORE}// mine\n`);
    await expect(
      runVortexE2e({
        checkout,
        artifactDir,
        patches: [patch],
        runner: stubRunner({}),
        leaseEnv,
        handleSignals: false,
      }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(fs.readFileSync(path.join(checkout, FIXTURE), "utf8")).toBe(
      `${FIXTURE_BEFORE}// mine\n`,
    );
    expect(readLease(INSTANCE_RESOURCE, leaseEnv)).toBeUndefined();
  });

  it("fails clearly when the patch no longer applies", async () => {
    fs.writeFileSync(path.join(checkout, FIXTURE), "export const moved = 1;\n");
    run(checkout, [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qam",
      "moved",
    ]);
    await expect(
      runVortexE2e({
        checkout,
        artifactDir,
        patches: [patch],
        runner: stubRunner({}),
        leaseEnv,
        handleSignals: false,
      }),
    ).rejects.toThrow(/does not apply cleanly/);
    expect(run(checkout, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("skips a patch the checkout already contains", async () => {
    fs.writeFileSync(path.join(checkout, FIXTURE), FIXTURE_AFTER);
    run(checkout, [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qam",
      "has fix",
    ]);
    const seen: { fixtureDuringRun?: string } = {};
    const report = await runVortexE2e({
      checkout,
      artifactDir,
      patches: [patch],
      runner: stubRunner(seen),
      leaseEnv,
      handleSignals: false,
    });
    expect(report.patches[0]).toMatchObject({ applied: false, alreadyPresent: true });
    expect(seen.fixtureDuringRun).toBe(FIXTURE_AFTER);
  });

  it("restores the fixture when the runner throws", async () => {
    await expect(
      runVortexE2e({
        checkout,
        artifactDir,
        patches: [patch],
        runner: async (invocation) => {
          if (invocation.list) return stubRunner({})(invocation);
          throw new Error("playwright crashed");
        },
        leaseEnv,
        handleSignals: false,
      }),
    ).rejects.toThrow("playwright crashed");
    expect(fs.readFileSync(path.join(checkout, FIXTURE), "utf8")).toBe(FIXTURE_BEFORE);
    expect(run(checkout, ["status", "--porcelain"]).trim()).toBe("");
    expect(readLease(INSTANCE_RESOURCE, leaseEnv)).toBeUndefined();
  });

  it("refuses while another owner holds the instance", async () => {
    const { acquireLease } = await import("./lease");
    acquireLease(INSTANCE_RESOURCE, "orchestrator", {
      ...leaseEnv,
      mode: "explicit",
      ttlMinutes: 5,
    });
    await expect(
      runVortexE2e({
        checkout,
        artifactDir,
        owner: "qa",
        patches: [patch],
        runner: stubRunner({}),
        leaseEnv,
        handleSignals: false,
      }),
    ).rejects.toThrow(/held by "orchestrator"/);
    expect(fs.readFileSync(path.join(checkout, FIXTURE), "utf8")).toBe(FIXTURE_BEFORE);
  });

  it("refuses while another owner holds the checkout, and releases the instance", async () => {
    const { acquireLease } = await import("./lease");
    acquireLease(checkoutResource(checkout), "fixer", {
      ...leaseEnv,
      mode: "explicit",
      ttlMinutes: 5,
    });
    await expect(
      runVortexE2e({
        checkout,
        artifactDir,
        owner: "qa",
        patches: [patch],
        runner: stubRunner({}),
        leaseEnv,
        handleSignals: false,
      }),
    ).rejects.toThrow(/The lease on .* is held by "fixer"/);
    expect(readLease(INSTANCE_RESOURCE, leaseEnv)).toBeUndefined();
    expect(fs.readFileSync(path.join(checkout, FIXTURE), "utf8")).toBe(FIXTURE_BEFORE);
  });
});
