/**
 * `vortex-e2e`: run Vortex's own Playwright suite (`<checkout>/packages/e2e`) so that it
 * gives a usable local result (see KNOWLEDGE.md, "Vortex's E2E suite cannot give a local
 * baseline as-is").
 *
 * Stock, the suite fails two ways on a developer machine: every account spec throws on a
 * missing credential variable, and most other specs lose a main-window startup race in
 * the fixture and then wait out a 6-minute timeout. This runner, for the run only:
 *
 *   - applies the kit's fixture patches (harness/patches) with `git apply`, after checking
 *     they apply cleanly and the files are unmodified, and puts the exact bytes back
 *     afterwards (finally and on Ctrl+C), verifying hashes and `git status`;
 *   - leaves out the specs that need a Nexus test account whose credentials are absent,
 *     through `--grep-invert`, and reports them separately rather than as failures.
 *
 * It holds the instance lease and the checkout's lease for the whole run (lease.ts).
 * Summary, comparison against a baseline and patch handling are exported for unit tests.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { REPO_ROOT } from "./config";
import {
  INSTANCE_RESOURCE,
  checkoutResource,
  holdLease,
  processAlive,
  readLease,
  resolveOwner,
  type HoldResult,
  type LeaseEnv,
} from "./lease";
import { readJsonFile } from "./jsonFile";
import { git, gitOk, parseUnifiedDiff, sha256 } from "./prPreflight";
import { childEnv } from "./source";

export class VortexE2eError extends Error {}

// ---------------------------------------------------------------------------
// Fixture patches
// ---------------------------------------------------------------------------

export interface FixturePatch {
  id: string;
  /** Absolute path of the patch file. */
  file: string;
  description: string;
}

export const FIXTURE_PATCHES: FixturePatch[] = [
  {
    id: "e2e-window-startup",
    file: path.join(REPO_ROOT, "harness", "patches", "e2e-window-startup.patch"),
    description:
      "packages/e2e fixture: accept a main window that appears before navigating, and a " +
      "renderer that finished loading before Playwright attached",
  },
];

export interface PatchResult {
  id: string;
  files: string[];
  /** Applied for this run. */
  applied: boolean;
  /** The checkout already contains the change; nothing was applied. */
  alreadyPresent: boolean;
}

export interface RestoreReport {
  restored: boolean;
  /** Files whose bytes differ from before the run. */
  mismatched: string[];
  /** `git status --porcelain` lines for the patched files that differ from before the run. */
  statusChanges: string[];
  /** Where the pre-run bytes are kept when the restore could not be verified. */
  backup?: string;
}

interface SavedFile {
  file: string;
  abs: string;
  bytes: Buffer | undefined;
  hash: string | undefined;
}

export interface PatchSession {
  results: PatchResult[];
  /** Put the saved bytes back. Synchronous, so a signal handler can call it. Idempotent. */
  restoreFiles: () => void;
  /** Restore (if not yet done) and check hashes and git status. */
  restoreAndVerify: () => Promise<RestoreReport>;
}

function patchFiles(patchText: string): string[] {
  return [...new Set(parseUnifiedDiff(patchText).flatMap((f) => [f.oldPath, f.newPath]))].filter(
    (p): p is string => p !== undefined,
  );
}

async function statusOf(dir: string, files: string[]): Promise<string> {
  return (await git(dir, ["status", "--porcelain", "--", ...files])).trim();
}

async function gitApply(dir: string, args: string[]): Promise<{ ok: boolean; message: string }> {
  try {
    await git(dir, ["apply", ...args]);
    return { ok: true, message: "" };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
    return { ok: false, message: stderr.trim() };
  }
}

/**
 * Apply each patch to the checkout for the duration of a run.
 *
 * Refuses when a patched file has uncommitted changes (the restore could not tell the
 * run's edits from the author's) and when a patch does not apply cleanly (the fixture
 * has moved on; guessing would test something else). A patch whose reverse applies is
 * already in the checkout, for example on a branch that carries the fix, and is skipped.
 */
export async function applyFixturePatches(
  checkout: string,
  patches: FixturePatch[],
  onProgress: (message: string) => void = () => undefined,
): Promise<PatchSession> {
  const dir = path.resolve(checkout);
  const plan: { patch: FixturePatch; files: string[]; alreadyPresent: boolean }[] = [];
  for (const patch of patches) {
    if (!fs.existsSync(patch.file)) throw new VortexE2eError(`Missing patch ${patch.file}.`);
    const files = patchFiles(fs.readFileSync(patch.file, "utf8"));
    if (files.length === 0) throw new VortexE2eError(`${patch.file} changes no files.`);
    const dirty = await statusOf(dir, files);
    if (dirty !== "") {
      throw new VortexE2eError(
        `Refusing to patch ${dir}: ${files.join(", ")} has uncommitted changes, so the ` +
          `run's edits could not be undone safely. Commit or stash them first.\n${dirty}`,
      );
    }
    if ((await gitApply(dir, ["--check", "--reverse", patch.file])).ok) {
      plan.push({ patch, files, alreadyPresent: true });
      continue;
    }
    const check = await gitApply(dir, ["--check", patch.file]);
    if (!check.ok) {
      throw new VortexE2eError(
        `The kit's fixture patch ${patch.id} (${patch.file}) does not apply cleanly to ${dir}. ` +
          `The E2E fixture has changed; update the patch rather than guessing.\n${check.message}`,
      );
    }
    plan.push({ patch, files, alreadyPresent: false });
  }

  const toApply = plan.filter((p) => !p.alreadyPresent);
  const saved: SavedFile[] = [...new Set(toApply.flatMap((p) => p.files))].map((file) => {
    const abs = path.join(dir, file);
    const bytes = fs.existsSync(abs) ? fs.readFileSync(abs) : undefined;
    return { file, abs, bytes, hash: bytes === undefined ? undefined : sha256(bytes) };
  });
  // Checked clean above, so after the restore git must again report nothing for them.
  const statusBefore = "";
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-e2e-patch-"));
  saved.forEach((entry, i) => {
    if (entry.bytes !== undefined) fs.writeFileSync(path.join(backup, String(i)), entry.bytes);
  });
  fs.writeFileSync(
    path.join(backup, "manifest.json"),
    JSON.stringify(
      saved.map((s, i) => ({ file: s.abs, backup: s.bytes === undefined ? null : String(i) })),
      null,
      2,
    ),
  );

  let restored = false;
  const restoreFiles = (): void => {
    if (restored) return;
    for (const entry of saved) {
      if (entry.bytes === undefined) fs.rmSync(entry.abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(entry.abs), { recursive: true });
        fs.writeFileSync(entry.abs, entry.bytes);
      }
    }
    restored = true;
  };

  const results: PatchResult[] = [];
  try {
    for (const { patch, files, alreadyPresent } of plan) {
      if (alreadyPresent) {
        onProgress(`[vortex-e2e] ${patch.id}: already in the checkout, not applied`);
      } else {
        const applied = await gitApply(dir, [patch.file]);
        if (!applied.ok)
          throw new VortexE2eError(`git apply ${patch.id} failed: ${applied.message}`);
        onProgress(`[vortex-e2e] ${patch.id}: applied for this run (${files.join(", ")})`);
      }
      results.push({ id: patch.id, files, applied: !alreadyPresent, alreadyPresent });
    }
  } catch (err) {
    restoreFiles();
    throw err;
  }

  return {
    results,
    restoreFiles,
    restoreAndVerify: async () => {
      restoreFiles();
      const mismatched = saved
        .filter((entry) => {
          const exists = fs.existsSync(entry.abs);
          if (entry.bytes === undefined) return exists;
          return !exists || sha256(fs.readFileSync(entry.abs)) !== entry.hash;
        })
        .map((entry) => entry.file);
      const statusAfter =
        saved.length === 0
          ? ""
          : await statusOf(
              dir,
              saved.map((s) => s.file),
            );
      const statusChanges =
        statusAfter === statusBefore ? [] : statusAfter.split("\n").filter((l) => l !== "");
      if (mismatched.length > 0 || statusChanges.length > 0) {
        return { restored: false, mismatched, statusChanges, backup };
      }
      fs.rmSync(backup, { recursive: true, force: true });
      return { restored: true, mismatched, statusChanges };
    },
  };
}

// ---------------------------------------------------------------------------
// Playwright JSON reports
// ---------------------------------------------------------------------------

interface JsonError {
  message?: string;
  stack?: string;
}

interface JsonResult {
  status?: string;
  duration?: number;
  error?: JsonError;
  errors?: JsonError[];
}

interface JsonTest {
  projectName?: string;
  status?: string;
  results?: JsonResult[];
}

interface JsonSpec {
  title: string;
  file: string;
  line: number;
  column: number;
  tests?: JsonTest[];
}

interface JsonSuite {
  title: string;
  file: string;
  line: number;
  column: number;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

export interface PlaywrightJsonReport {
  config?: { rootDir?: string };
  suites?: JsonSuite[];
  errors?: JsonError[];
  stats?: { duration?: number; startTime?: string };
}

export interface ListedTest {
  id: string;
  /** Spec file relative to the suite's test directory, forward slashes. */
  file: string;
  line: number;
  column: number;
  /** Describe titles then the test title. */
  titlePath: string[];
  project: string;
  /** Enclosing describe blocks, outermost first. */
  describes: { title: string; line: number; column: number }[];
}

export type TestStatus = "passed" | "failed" | "skipped" | "flaky";

export interface TestOutcome {
  id: string;
  file: string;
  line: number;
  title: string;
  status: TestStatus;
  /** Playwright's result status of the last attempt (passed, failed, timedOut, ...). */
  result?: string;
  error?: string;
  durationMs?: number;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

export function firstLine(text: string | undefined, max = 300): string | undefined {
  if (text === undefined) return undefined;
  const line = text
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function testId(file: string, titlePath: string[], project = ""): string {
  return `${project === "" ? "" : `[${project}] `}${file.replace(/\\/g, "/")} :: ${titlePath.join(" > ")}`;
}

/** Every test in a report, with where it is declared. */
export function listedTests(report: PlaywrightJsonReport): ListedTest[] {
  const out: ListedTest[] = [];
  const walk = (suite: JsonSuite, titles: string[], describes: ListedTest["describes"]): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? [{}]) {
        const titlePath = [...titles, spec.title];
        const project = test.projectName ?? "";
        out.push({
          id: testId(spec.file, titlePath, project),
          file: spec.file.replace(/\\/g, "/"),
          line: spec.line,
          column: spec.column,
          titlePath,
          project,
          describes,
        });
      }
    }
    for (const child of suite.suites ?? []) {
      walk(
        child,
        [...titles, child.title],
        [...describes, { title: child.title, line: child.line, column: child.column }],
      );
    }
  };
  // Top-level suites are files; their titles are not part of a test's title path.
  for (const file of report.suites ?? []) {
    for (const spec of file.specs ?? []) walk({ ...file, suites: [], specs: [spec] }, [], []);
    for (const child of file.suites ?? []) {
      walk(child, [child.title], [{ title: child.title, line: child.line, column: child.column }]);
    }
  }
  return out;
}

/** What each test did, from a run's JSON report. */
export function outcomes(report: PlaywrightJsonReport): TestOutcome[] {
  const out: TestOutcome[] = [];
  const walk = (suite: JsonSuite, titles: string[]): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const titlePath = [...titles, spec.title];
        const results = test.results ?? [];
        const last = results.at(-1);
        let status: TestStatus;
        if (test.status === "skipped" || (test.status === "expected" && last?.status === "skipped"))
          status = "skipped";
        else if (test.status === "expected") status = "passed";
        else if (test.status === "flaky") status = "flaky";
        else status = "failed";
        const error =
          status === "failed"
            ? firstLine(last?.error?.message ?? last?.errors?.[0]?.message ?? last?.status)
            : undefined;
        out.push({
          id: testId(spec.file, titlePath, test.projectName ?? ""),
          file: spec.file.replace(/\\/g, "/"),
          line: spec.line,
          title: titlePath.join(" > "),
          status,
          result: last?.status,
          error,
          durationMs: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) {
    for (const spec of file.specs ?? []) walk({ ...file, suites: [], specs: [spec] }, []);
    for (const child of file.suites ?? []) walk(child, [child.title]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Credential-gated tests
// ---------------------------------------------------------------------------

export type Account = "free" | "premium";

export const ACCOUNT_ENV: Record<Account, [string, string]> = {
  free: ["E2E_NEXUS_FREE_USER_USERNAME", "E2E_NEXUS_FREE_USER_PASSWORD"],
  premium: ["E2E_NEXUS_PREMIUM_USER_USERNAME", "E2E_NEXUS_PREMIUM_USER_PASSWORD"],
};

/** Which Nexus test accounts are configured, from the environment and packages/e2e/.env. */
export function configuredAccounts(
  e2eDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<Account, boolean> {
  let fileEnv: Record<string, string | undefined> = {};
  const envFile = path.join(e2eDir, ".env");
  if (fs.existsSync(envFile)) {
    try {
      fileEnv = parseEnv(fs.readFileSync(envFile, "utf8"));
    } catch {
      fileEnv = {};
    }
  }
  const has = (name: string): boolean => (env[name] ?? fileEnv[name] ?? "").trim() !== "";
  return {
    free: ACCOUNT_ENV.free.every(has),
    premium: ACCOUNT_ENV.premium.every(has),
  };
}

/**
 * Offset just past the call whose first `(` is at or after `from`, or undefined.
 * Skips strings, comments and template literals (including `${}`); regex literals are
 * not recognised, which the specs' call headers do not need.
 */
export function callEnd(src: string, from: number): number | undefined {
  let i = src.indexOf("(", from);
  if (i < 0) return undefined;
  const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  const template = (start: number): number => {
    let j = start;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") j += 2;
      else if (c === "`") return j + 1;
      else if (c === "$" && src[j + 1] === "{") {
        stack.push("tmpl");
        return j + 2;
      } else j++;
    }
    return src.length;
  };
  while (i < src.length) {
    const c = src[i] ?? "";
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === "`") {
      i = template(i + 1);
      continue;
    }
    const closer = closers[c];
    if (closer !== undefined) {
      stack.push(closer);
    } else if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (top === "tmpl") {
        i = template(i + 1);
        continue;
      }
      if (stack.length === 0) return i + 1;
    }
    i++;
  }
  return undefined;
}

function lineOffsets(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

const USE_NEXUS_USER = /nexusUser\s*:\s*([A-Za-z_$][\w$]*)/g;

/**
 * The Nexus test accounts a test needs: the `nexusUser` its innermost describe sets with
 * `test.use` (a file-level `test.use` applies to all of its tests), plus `freeUser` or
 * `premiumUser` named in the test's own body. A `nexusUser` taken from a loop variable is
 * resolved from a "free" or "premium" in the describe's or test's title; failing that,
 * both accounts are assumed.
 */
export function accountsForTest(src: string, test: ListedTest): Account[] {
  const starts = lineOffsets(src);
  const offset = (line: number, column: number): number =>
    (starts[line - 1] ?? src.length) + Math.max(0, column - 1);
  const range = (line: number, column: number): [number, number] => {
    const start = offset(line, column);
    return [start, callEnd(src, start) ?? src.length];
  };
  const describes = test.describes.map((d) => ({ ...d, range: range(d.line, d.column) }));
  const uses = [...src.matchAll(USE_NEXUS_USER)].map((m) => ({
    at: m.index ?? 0,
    ident: m[1] ?? "",
  }));
  const allDescribes = describeRanges(src);

  let needed: Account[] = [];
  let decided = false;
  // Innermost describe first: a nested test.use overrides an outer one.
  for (let d = describes.length - 1; d >= 0 && !decided; d--) {
    const own = describes[d];
    if (own === undefined) continue;
    // A use directly in this describe, not in a describe nested inside it (an ancestor
    // of this test or a sibling's).
    const nested = allDescribes.filter((r) => r[0] > own.range[0] && r[1] <= own.range[1]);
    const direct = uses.find(
      (use) => inside(use.at, own.range) && !nested.some((r) => inside(use.at, r)),
    );
    if (direct !== undefined) {
      needed = accountsFromIdent(direct.ident, [own.title, test.titlePath.at(-1) ?? ""]);
      decided = true;
    }
  }
  if (!decided) {
    // Only a use outside every describe is file level.
    const fileLevel = uses.find((use) => !allDescribes.some((r) => inside(use.at, r)));
    if (fileLevel !== undefined) {
      needed = accountsFromIdent(fileLevel.ident, test.titlePath.toReversed());
    }
  }
  const [start, end] = range(test.line, test.column);
  const body = src.slice(start, end);
  const set = new Set(needed);
  if (/\bfreeUser\b/.test(body)) set.add("free");
  if (/\bpremiumUser\b/.test(body)) set.add("premium");
  return [...set].toSorted();
}

/** Every `test.describe(...)` call in a file, as [start, end) offsets. */
function describeRanges(src: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of src.matchAll(/\btest\.describe(?:\.\w+)*\s*\(/g)) {
    const start = match.index ?? 0;
    ranges.push([start, callEnd(src, start) ?? src.length]);
  }
  return ranges;
}

function inside(at: number, [start, end]: [number, number]): boolean {
  return at > start && at < end;
}

function accountsFromIdent(ident: string, titles: string[]): Account[] {
  if (ident === "freeUser") return ["free"];
  if (ident === "premiumUser") return ["premium"];
  if (ident === "null" || ident === "undefined") return [];
  // The nearest title that names exactly one tier decides ("free" beats a test title
  // that says "free user does NOT see the Premium badge").
  for (const title of titles) {
    const premium = /\bpremium\b/i.test(title);
    const free = /\bfree\b/i.test(title);
    if (premium !== free) return premium ? ["premium"] : ["free"];
  }
  return ["free", "premium"];
}

export interface CredentialSkip {
  id: string;
  file: string;
  line: number;
  title: string;
  accounts: Account[];
}

export function credentialSkips(
  tests: ListedTest[],
  readSource: (file: string) => string,
  configured: Record<Account, boolean>,
): CredentialSkip[] {
  const sources = new Map<string, string>();
  const skips: CredentialSkip[] = [];
  for (const test of tests) {
    let src = sources.get(test.file);
    if (src === undefined) {
      src = readSource(test.file);
      sources.set(test.file, src);
    }
    const accounts = accountsForTest(src, test);
    if (accounts.some((account) => !configured[account])) {
      skips.push({
        id: test.id,
        file: test.file,
        line: test.line,
        title: test.titlePath.join(" > "),
        accounts,
      });
    }
  }
  return skips;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A `--grep-invert` pattern matching exactly these tests. Playwright matches it against
 * "<project> <file> <describe titles> <title> <tags>", space-separated.
 */
export function grepInvertFor(tests: { file: string; titlePath: string[] }[]): string | undefined {
  if (tests.length === 0) return undefined;
  const patterns = [
    ...new Set(
      tests.map(
        (t) =>
          `(?:^|[\\\\/ ])${escapeRegExp(path.posix.basename(t.file))} ` +
          `${escapeRegExp(t.titlePath.join(" "))}(?: @|$)`,
      ),
    ),
  ];
  return patterns.join("|");
}

// ---------------------------------------------------------------------------
// Summary and comparison
// ---------------------------------------------------------------------------

export interface E2eCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  credentialSkipped: number;
}

export interface Comparison {
  baseline: string;
  baselineHead: string;
  /** Failing now, not failing in the baseline. */
  regressions: {
    id: string;
    error?: string;
    baseline: TestStatus | "absent" | "credential-skipped";
  }[];
  /** Failing in both runs. */
  preExisting: { id: string; error?: string }[];
  /** Failing in the baseline, passing now. */
  fixed: string[];
  /** In the baseline's results but not run now. */
  notRun: string[];
}

export interface VortexE2eReport {
  tool: "vortex-e2e";
  schemaVersion: 1;
  checkout: string;
  headSha: string;
  owner: string;
  startedAt: string;
  durationMs: number;
  playwrightDurationMs?: number;
  command: string[];
  specs: string[];
  grep?: string;
  accounts: Record<Account, boolean>;
  patches: (PatchResult & { restored: boolean })[];
  restore?: RestoreReport;
  counts: E2eCounts;
  failures: { id: string; file: string; line: number; error?: string }[];
  credentialSkipped: CredentialSkip[];
  outcomes: TestOutcome[];
  globalErrors: string[];
  playwrightExitCode: number | null;
  notes: string[];
  compare?: Comparison;
  reportFile?: string;
  playwrightReportFile?: string;
}

export function summarise(
  results: TestOutcome[],
  credentialSkipped: CredentialSkip[],
): { counts: E2eCounts; failures: VortexE2eReport["failures"] } {
  const count = (status: TestStatus): number => results.filter((r) => r.status === status).length;
  return {
    counts: {
      total: results.length + credentialSkipped.length,
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
      flaky: count("flaky"),
      credentialSkipped: credentialSkipped.length,
    },
    failures: results
      .filter((r) => r.status === "failed")
      .map((r) => ({ id: r.id, file: r.file, line: r.line, error: r.error })),
  };
}

export function compareRuns(
  current: Pick<VortexE2eReport, "outcomes" | "credentialSkipped">,
  baseline: Pick<VortexE2eReport, "outcomes" | "credentialSkipped" | "headSha">,
  baselineFile: string,
): Comparison {
  const before = new Map(baseline.outcomes.map((o) => [o.id, o]));
  const beforeSkipped = new Set(baseline.credentialSkipped.map((s) => s.id));
  const now = new Map(current.outcomes.map((o) => [o.id, o]));
  const nowSkipped = new Set(current.credentialSkipped.map((s) => s.id));
  const comparison: Comparison = {
    baseline: baselineFile,
    baselineHead: baseline.headSha,
    regressions: [],
    preExisting: [],
    fixed: [],
    notRun: [],
  };
  for (const outcome of current.outcomes) {
    const old = before.get(outcome.id);
    if (outcome.status === "failed") {
      if (old?.status === "failed") {
        comparison.preExisting.push({ id: outcome.id, error: outcome.error });
      } else {
        comparison.regressions.push({
          id: outcome.id,
          error: outcome.error,
          baseline:
            old?.status ?? (beforeSkipped.has(outcome.id) ? "credential-skipped" : "absent"),
        });
      }
    } else if (outcome.status === "passed" && old?.status === "failed") {
      comparison.fixed.push(outcome.id);
    }
  }
  for (const old of baseline.outcomes) {
    if (!now.has(old.id) && !nowSkipped.has(old.id)) comparison.notRun.push(old.id);
  }
  return comparison;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0
    ? `${String(minutes)}m${String(seconds % 60).padStart(2, "0")}s`
    : `${String(seconds)}s`;
}

export function formatE2eReport(report: VortexE2eReport): string {
  const { counts } = report;
  const lines = [
    `vortex-e2e ${report.checkout} (HEAD ${report.headSha.slice(0, 9)}), owner "${report.owner}"`,
  ];
  for (const patch of report.patches) {
    lines.push(
      `fixture patch ${patch.id}: ${
        patch.alreadyPresent
          ? "already in the checkout"
          : patch.applied
            ? `applied for the run, ${patch.restored ? "restored byte-identically" : "NOT RESTORED"}`
            : "not applied"
      }`,
    );
  }
  lines.push(
    `accounts: free ${report.accounts.free ? "configured" : "absent"}, premium ${
      report.accounts.premium ? "configured" : "absent"
    }`,
    `${String(counts.passed)} passed, ${String(counts.failed)} failed, ${String(counts.skipped)} skipped, ` +
      `${String(counts.credentialSkipped)} skipped for missing credentials` +
      (counts.flaky > 0 ? `, ${String(counts.flaky)} flaky` : "") +
      ` (${String(counts.total)} tests) in ${formatDuration(report.durationMs)}`,
  );
  for (const note of report.notes) lines.push(`note: ${note}`);
  for (const error of report.globalErrors) lines.push(`ERROR: ${error}`);
  if (report.failures.length > 0) {
    lines.push("", "Failures:");
    for (const failure of report.failures) {
      lines.push(
        `  ${failure.id} (line ${String(failure.line)})`,
        `    ${failure.error ?? "(no error message)"}`,
      );
    }
  }
  if (report.credentialSkipped.length > 0) {
    const by = (account: Account): number =>
      report.credentialSkipped.filter((s) => s.accounts.includes(account)).length;
    lines.push(
      "",
      `Skipped for missing credentials: ${String(report.credentialSkipped.length)} tests ` +
        `(need free: ${String(by("free"))}, need premium: ${String(by("premium"))}); ` +
        `set ${[...ACCOUNT_ENV.free, ...ACCOUNT_ENV.premium].join(", ")} to run them. ` +
        "The list is in the JSON report.",
    );
  }
  if (report.compare !== undefined) {
    const c = report.compare;
    lines.push(
      "",
      `Against ${c.baseline} (HEAD ${c.baselineHead.slice(0, 9)}): ${String(c.regressions.length)} regressions, ` +
        `${String(c.preExisting.length)} pre-existing failures, ${String(c.fixed.length)} fixed, ` +
        `${String(c.notRun.length)} not run this time`,
    );
    for (const r of c.regressions) {
      lines.push(`  REGRESSION ${r.id} (baseline: ${r.baseline})`, `    ${r.error ?? ""}`);
    }
    for (const p of c.preExisting) lines.push(`  pre-existing ${p.id}`);
    for (const f of c.fixed) lines.push(`  fixed ${f}`);
  }
  if (report.restore !== undefined && !report.restore.restored) {
    lines.push(
      "",
      `RESTORE FAILED: the patched files are not back as they were. Backup: ${report.restore.backup ?? "?"}`,
      ...report.restore.mismatched.map((m) => `  differs: ${m}`),
      ...report.restore.statusChanges.map((s) => `  status: ${s}`),
    );
  }
  if (report.reportFile !== undefined) lines.push("", `Report: ${report.reportFile}`);
  return lines.join("\n");
}

/** Exit status: failures (or, with a baseline, regressions), global errors, or a bad restore. */
export function e2eExitCode(report: VortexE2eReport): number {
  if (report.restore !== undefined && !report.restore.restored) return 1;
  if (report.globalErrors.length > 0) return 1;
  if (report.compare !== undefined) return report.compare.regressions.length > 0 ? 1 : 0;
  return report.counts.failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Running Playwright
// ---------------------------------------------------------------------------

export interface PlaywrightInvocation {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Where the JSON reporter writes (PLAYWRIGHT_JSON_OUTPUT_FILE is set to it). */
  jsonFile: string;
  /** A `--list` run: output is not streamed. */
  list: boolean;
  signal: AbortSignal;
}

export type PlaywrightRunner = (
  invocation: PlaywrightInvocation,
) => Promise<{ code: number | null }>;

/** Playwright's CLI from the checkout's own install, run with this Node; no shell quoting. */
export function playwrightRunner(stream: NodeJS.WritableStream): PlaywrightRunner {
  return (invocation) =>
    new Promise((resolve, reject) => {
      let cli: string;
      try {
        const require = createRequire(path.join(invocation.cwd, "package.json"));
        cli = path.join(path.dirname(require.resolve("@playwright/test/package.json")), "cli.js");
      } catch {
        reject(
          new VortexE2eError(
            `@playwright/test is not installed in ${invocation.cwd}. Run pnpm install in the checkout.`,
          ),
        );
        return;
      }
      const child = spawn(process.execPath, [cli, ...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const abort = (): void => {
        child.kill();
      };
      invocation.signal.addEventListener("abort", abort, { once: true });
      const forward = (chunk: Buffer): void => {
        if (!invocation.list) stream.write(chunk);
      };
      child.stdout.on("data", forward);
      child.stderr.on("data", forward);
      child.on("error", reject);
      child.on("close", (code) => {
        invocation.signal.removeEventListener("abort", abort);
        resolve({ code });
      });
    });
}

export interface VortexE2eOptions {
  checkout: string;
  artifactDir: string;
  specs?: string[];
  grep?: string;
  grepInvert?: string;
  owner?: string;
  /** A previous report to compare with. */
  compare?: string;
  patches?: FixturePatch[];
  runner?: PlaywrightRunner;
  leaseEnv?: LeaseEnv;
  onProgress?: (message: string) => void;
  /** Install SIGINT/SIGTERM/SIGHUP handlers that restore and exit. Default true. */
  handleSignals?: boolean;
}

function readJson(file: string): PlaywrightJsonReport {
  if (!fs.existsSync(file)) {
    throw new VortexE2eError(`Playwright wrote no JSON report to ${file}.`);
  }
  return readJsonFile<PlaywrightJsonReport>(file);
}

function baseEnv(): NodeJS.ProcessEnv {
  const env = childEnv();
  // Upstream CI's launch: hidden window, and no inherited Electron mode.
  delete env.VORTEX_E2E_HEADED;
  delete env.ELECTRON_RUN_AS_NODE;
  env.CI = "1";
  return env;
}

export async function runVortexE2e(options: VortexE2eOptions): Promise<VortexE2eReport> {
  const started = Date.now();
  const report = options.onProgress ?? ((): void => undefined);
  const checkout = path.resolve(options.checkout);
  const e2eDir = path.join(checkout, "packages", "e2e");
  if (!fs.existsSync(path.join(e2eDir, "playwright.config.ts"))) {
    throw new VortexE2eError(
      `${e2eDir} has no playwright.config.ts. Pass --checkout <Vortex checkout>.`,
    );
  }
  if (!(await gitOk(checkout, ["rev-parse", "--git-dir"]))) {
    throw new VortexE2eError(`${checkout} is not a git checkout.`);
  }
  const headSha = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const owner = resolveOwner(options.owner);
  const runner = options.runner ?? playwrightRunner(process.stdout);
  const specs = (options.specs ?? []).map((spec) => {
    const abs = path.resolve(e2eDir, spec);
    const inE2e = fs.existsSync(abs) ? abs : path.resolve(e2eDir, "src", "tests", spec);
    return path.relative(e2eDir, inE2e).replace(/\\/g, "/");
  });
  const baseline =
    options.compare === undefined ? undefined : readJsonFile<VortexE2eReport>(options.compare);
  const notes: string[] = [];

  const leases: HoldResult[] = [];
  const onReclaim = (state: { lease: { owner: string; resource: string }; reason: string }): void =>
    report(
      `[lease] reclaimed stale ${state.lease.resource} lease from "${state.lease.owner}" (${state.reason})`,
    );
  leases.push(
    holdLease(INSTANCE_RESOURCE, owner, { ...options.leaseEnv, purpose: "vortex-e2e", onReclaim }),
  );
  let session: PatchSession | undefined;
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals): void => {
    controller.abort();
    session?.restoreFiles();
    for (const lease of leases.toReversed()) lease.release();
    process.stderr.write(`[vortex-e2e] ${signal}: fixture files restored, leases released\n`);
    process.exit(130);
  };
  if (options.handleSignals !== false) signals.forEach((s) => process.once(s, onSignal));

  try {
    leases.push(
      holdLease(checkoutResource(checkout), owner, {
        ...options.leaseEnv,
        purpose: "vortex-e2e fixture patch",
        onReclaim,
      }),
    );
    const running = (
      readLease(INSTANCE_RESOURCE, options.leaseEnv)?.lease.instancePids ?? []
    ).filter(options.leaseEnv?.isAlive ?? processAlive);
    if (running.length > 0) {
      notes.push(
        `a harness Vortex (pid ${running.join(", ")}) was running during the run; timings may be affected`,
      );
    }

    session = await applyFixturePatches(checkout, options.patches ?? FIXTURE_PATCHES, report);

    const stamp = new Date(started).toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(options.artifactDir, "vortex-e2e");
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `${stamp}-${headSha.slice(0, 9)}`);
    const env = baseEnv();
    const selection = [...specs, ...(options.grep === undefined ? [] : ["--grep", options.grep])];
    let rootDir = path.join(e2eDir, "src", "tests");
    const list = async (grepInvert: string | undefined): Promise<ListedTest[]> => {
      const jsonFile = `${base}.list.json`;
      fs.rmSync(jsonFile, { force: true });
      const result = await runner({
        cwd: e2eDir,
        args: [
          "test",
          "--list",
          "--reporter=json",
          ...selection,
          ...(grepInvert === undefined ? [] : ["--grep-invert", grepInvert]),
        ],
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile },
        jsonFile,
        list: true,
        signal: controller.signal,
      });
      const listed = readJson(jsonFile);
      fs.rmSync(jsonFile, { force: true });
      if (result.code !== 0 && (listed.errors?.length ?? 0) > 0) {
        throw new VortexE2eError(
          `Listing the tests failed: ${listed.errors?.map((e) => firstLine(e.message)).join("; ") ?? ""}`,
        );
      }
      // Spec paths in the report are relative to the configured test directory.
      if (listed.config?.rootDir !== undefined) rootDir = path.resolve(listed.config.rootDir);
      return listedTests(listed);
    };

    const combineInvert = (ours: string | undefined): string | undefined =>
      [options.grepInvert, ours]
        .filter((p): p is string => p !== undefined && p !== "")
        .map((p) => `(?:${p})`)
        .join("|") || undefined;

    const all = await list(combineInvert(undefined));
    if (all.length === 0) throw new VortexE2eError("No tests match the given --spec/--grep.");
    const accounts = configuredAccounts(e2eDir);
    const skipped = credentialSkips(
      all,
      (file) => fs.readFileSync(path.join(rootDir, file), "utf8"),
      accounts,
    );
    const invert = combineInvert(
      grepInvertFor(all.filter((t) => skipped.some((s) => s.id === t.id))),
    );
    report(
      `[vortex-e2e] ${String(all.length)} tests selected, ${String(skipped.length)} left out for missing credentials`,
    );

    let results: TestOutcome[] = [];
    let globalErrors: string[] = [];
    let playwrightExitCode: number | null = 0;
    let playwrightDurationMs: number | undefined;
    const command = [
      "playwright",
      "test",
      ...selection,
      "--workers=1",
      "--retries=0",
      "--reporter=list,json",
      ...(invert === undefined ? [] : ["--grep-invert", invert]),
    ];
    if (skipped.length < all.length) {
      // Check the exclusion does exactly what was computed before spending hours on it.
      const kept = await list(invert);
      if (kept.length !== all.length - skipped.length) {
        throw new VortexE2eError(
          `The credential filter kept ${String(kept.length)} tests, expected ` +
            `${String(all.length - skipped.length)}. Not running with a filter that is wrong.`,
        );
      }
      const jsonFile = `${base}.playwright.json`;
      report(`[vortex-e2e] running ${String(kept.length)} tests in ${e2eDir}`);
      const result = await runner({
        cwd: e2eDir,
        args: command.slice(1),
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile },
        jsonFile,
        list: false,
        signal: controller.signal,
      });
      playwrightExitCode = result.code;
      const json = readJson(jsonFile);
      results = outcomes(json);
      globalErrors = (json.errors ?? [])
        .map((e) => firstLine(e.message ?? e.stack))
        .filter((e): e is string => e !== undefined);
      playwrightDurationMs = json.stats?.duration;
    } else {
      notes.push("every selected test needs an absent account; Playwright was not started");
    }

    const restore = await session.restoreAndVerify();
    const { counts, failures } = summarise(results, skipped);
    const final: VortexE2eReport = {
      tool: "vortex-e2e",
      schemaVersion: 1,
      checkout,
      headSha,
      owner,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      playwrightDurationMs,
      command,
      specs,
      grep: options.grep,
      accounts,
      patches: session.results.map((p) => ({
        ...p,
        restored: p.applied ? restore.restored : true,
      })),
      restore,
      counts,
      failures,
      credentialSkipped: skipped,
      outcomes: results,
      globalErrors,
      playwrightExitCode,
      notes,
      playwrightReportFile: skipped.length < all.length ? `${base}.playwright.json` : undefined,
    };
    if (baseline !== undefined && options.compare !== undefined) {
      final.compare = compareRuns(final, baseline, options.compare);
    }
    final.reportFile = `${base}.json`;
    fs.writeFileSync(final.reportFile, `${JSON.stringify(final, null, 2)}\n`);
    return final;
  } finally {
    session?.restoreFiles();
    signals.forEach((s) => process.removeListener(s, onSignal));
    for (const lease of leases.toReversed()) lease.release();
  }
}
