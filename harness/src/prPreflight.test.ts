import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commentText,
  computeSize,
  lintPullRequest,
  measurementsInComments,
  parseUnifiedDiff,
  runPreflight,
  sizeCheck,
  touchedSymbols,
  type FileDiff,
  type PullRequestText,
  type TestRunner,
} from "./prPreflight";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,2 +3,3 @@ export function a() {
-  return 1;
+  // was 250ms, now 40 ms
+  return 2;
+  return 3;
diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = 1;
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-a
+b
diff --git a/icon.png b/icon.png
new file mode 100644
Binary files /dev/null and b/icon.png differ
`;

function file(pathName: string, added: string[] = [], removed: string[] = []): FileDiff {
  return {
    path: pathName,
    oldPath: pathName,
    newPath: pathName,
    binary: false,
    added: added.map((text, i) => ({ line: i + 1, text })),
    removed: removed.map((text, i) => ({ line: i + 1, text })),
  };
}

describe("diff parsing and size", () => {
  it("tracks line numbers, renames, deletions and binaries", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/new.ts",
      "src/gone.ts",
      "pnpm-lock.yaml",
      "icon.png",
    ]);
    const [a, renamed, gone, , png] = files;
    expect(a?.removed).toEqual([{ line: 3, text: "  return 1;" }]);
    expect(a?.added.map((l) => l.line)).toEqual([3, 4, 5]);
    expect(renamed).toMatchObject({ oldPath: "src/old.ts", newPath: "src/new.ts" });
    expect(gone).toMatchObject({ oldPath: "src/gone.ts", newPath: undefined });
    expect(png).toMatchObject({ binary: true, oldPath: undefined });
  });

  it("excludes lockfiles and API reports from the CONTRIBUTING.md size", () => {
    const size = computeSize([...parseUnifiedDiff(DIFF), file("etc/vortex.api.md", ["x", "y"])]);
    expect(size).toMatchObject({ lines: 5, files: 4, added: 3, removed: 2 });
    expect(size.excluded).toEqual(["pnpm-lock.yaml", "etc/vortex.api.md"]);
  });

  it("warns above 400 lines or 10 files", () => {
    expect(sizeCheck([file("a.ts", Array(400).fill("x"))]).status).toBe("pass");
    expect(sizeCheck([file("a.ts", Array(401).fill("x"))]).status).toBe("warn");
    expect(
      sizeCheck(Array.from({ length: 11 }, (_, i) => file(`f${String(i)}.ts`, ["x"]))).status,
    ).toBe("warn");
  });
});

const SOURCE = `import x from "y";

export function exported(a: number) {
  const inner = () => {
    return a;
  };
  return inner();
}

function local() {
  return 1;
}

export class Manager {
  private mCount = 0;

  constructor() {
    this.mCount = 1;
  }

  public install(id: string) {
    if (id) {
      doThing(id, () => {
        return id;
      });
    }
  }

  private onDone = (err: Error) => {
    this.mCount--;
  };

  public configure(
    a: number,
  ): void {
    if (a) {
      this.mCount = a;
    } else {
      this.mCount = -a;
    }
  }
}

export interface Options {
  name: string;
}

const Widget = (props: Options) => {
  return null;
};

export default Widget;
`;

const lineOf = (text: string): number => SOURCE.split("\n").findIndex((l) => l.includes(text)) + 1;

describe("touched symbols", () => {
  const symbols = (...texts: string[]) =>
    touchedSymbols(SOURCE, texts.map(lineOf), "src/m.ts", "head").map((s) =>
      [s.className, s.name, s.kind].filter((v) => v !== undefined).join(":"),
    );

  it("reports the exported function enclosing a nested change", () => {
    expect(symbols("return a;")).toEqual(["exported:function"]);
  });

  it("ignores top-level declarations that are not exported", () => {
    expect(symbols("return 1;")).toEqual([]);
  });

  it("reports class members through nested blocks and arrow properties", () => {
    expect(symbols("return id;", "this.mCount--", "private mCount")).toEqual([
      "Manager:install:method",
      "Manager:onDone:method",
      "Manager:mCount:property",
    ]);
  });

  it("follows multi-line signatures and else branches to the method", () => {
    expect(symbols("this.mCount = a;", "this.mCount = -a;")).toEqual(["Manager:configure:method"]);
  });

  it("maps a changed constructor to its class", () => {
    expect(symbols("this.mCount = 1;")).toEqual(["Manager:class"]);
  });

  it("finds components exported by name, types, and closing braces", () => {
    expect(symbols("return null;")).toEqual(["Widget:component"]);
    expect(symbols("name: string;")).toEqual(["Options:type"]);
    const closing = SOURCE.split("\n").indexOf("}", lineOf("return inner();")) + 1;
    expect(touchedSymbols(SOURCE, [closing], "m.ts", "head").map((s) => s.name)).toEqual([
      "exported",
    ]);
  });
});

describe("measurements in comments", () => {
  it("extracts comments without mistaking URLs for them", () => {
    expect(commentText('const u = "https://example.test/5ms";')).toBeUndefined();
    expect(commentText("foo(); // 10x faster")).toBe(" 10x faster");
    expect(commentText(" * takes 3 s")).toBe("* takes 3 s");
  });

  it("flags figures in added comments only", () => {
    const findings = measurementsInComments([
      file("src/a.ts", [
        "// was 250ms, now 40 ms",
        "const timeout = 500; // ms",
        "// dropped from 12 to 3 renders",
        "// uses 20% less memory",
        "// see issue 24282",
        "const ratio = 10; // 0x1F mask",
        "const delay = 250;",
      ]),
      file("README.md", ["<!-- 5ms -->"]),
    ]);
    expect(findings.map((f) => f.line)).toEqual([1, 3, 4]);
  });
});

const GOOD_BODY = `## Problem

Broken.

## Change

Fixed.

## Behaviour changes

None.

## Evidence

- pnpm run verify on abc1234: passed.
- E2E: 30 passed.

## Review

1 judgment.

## Not covered

Nothing.
`;

describe("PR description lint", () => {
  const pr = (patch: Partial<PullRequestText> = {}): PullRequestText => ({
    title: "fix(collections): release the check suppression on cancel",
    body: GOOD_BODY,
    headRefOid: "abc1234def5678abc1234def5678abc1234def56",
    ...patch,
  });

  it("passes a description that follows PULL-REQUESTS.md", () => {
    expect(lintPullRequest(pr())).toMatchObject({ status: "pass", details: [] });
  });

  it("fails bad titles, missing sections, Not run and a stale head", () => {
    const result = lintPullRequest(
      pr({
        title: `Fix the thing. ${"x".repeat(70)}`,
        body:
          GOOD_BODY.replace("## Not covered", "## Other").replace("abc1234", "fff9999") +
          "\nE2E: Not run\n",
      }),
    );
    expect(result.status).toBe("fail");
    const text = result.details.join("\n");
    expect(text).toContain("Conventional Commits");
    expect(text).toContain("<= 72");
    expect(text).toContain('missing section "## Not covered"');
    expect(text).toContain("Not run");
    expect(text).toContain("head commit abc1234");
  });

  it("warns when Evidence lacks verify or E2E and when the local head differs", () => {
    const result = lintPullRequest(
      pr({ body: GOOD_BODY.replace("pnpm run verify", "tests").replace("E2E", "app") }),
      "0000000000000000000000000000000000000000",
    );
    expect(result.status).toBe("warn");
    expect(result.details).toHaveLength(3);
  });

  it("reads subsections as part of their section", () => {
    const body = GOOD_BODY.replace("- pnpm run verify", "### Gates\n\n- pnpm run verify");
    expect(lintPullRequest(pr({ body }))).toMatchObject({ status: "pass" });
  });

  it("ignores headings inside code fences", () => {
    const body = GOOD_BODY.replace("## Review", "```\n## Review\n```");
    expect(lintPullRequest(pr({ body })).details).toContain('missing section "## Review"');
  });
});

// ---------------------------------------------------------------------------
// Against a real temporary git repository
// ---------------------------------------------------------------------------

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

describe("runPreflight on a git checkout", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-"));
    run(repo, "init", "-q", "-b", "master");
    run(repo, "config", "user.email", "test@example.test");
    run(repo, "config", "user.name", "Test");
    run(repo, "config", "core.autocrlf", "false");
    write(repo, "package.json", "{}\n");
    write(repo, "src/util.ts", "export function limit(n: number) {\n  return n;\n}\n");
    write(repo, "src/caller.ts", 'import { limit } from "./util";\nlimit(1);\n');
    write(repo, "src/obsolete.ts", "export const obsolete = true;\n");
    write(
      repo,
      "src/index.ts",
      "export class Index {\n  lookup(k: string) {\n    return k;\n  }\n}\n",
    );
    write(repo, "src/other.ts", "// Index is mentioned only in a comment\nunrelated.lookup();\n");
    write(repo, "extensions/ext/index.test.ts", 'import { limit } from "../../src/util";\n');
    run(repo, "add", ".");
    run(repo, "commit", "-q", "-m", "base");
    run(repo, "checkout", "-q", "-b", "fix");
    // CRLF and a binary-ish byte check the restore is byte-identical.
    write(
      repo,
      "src/util.ts",
      "export function limit(n: number) {\r\n  return Math.min(n, 5);\r\n}\r\nÿ",
    );
    write(repo, "src/added/helper.ts", "export const helper = 1; // 3x faster\n");
    fs.rmSync(path.join(repo, "src/obsolete.ts"));
    write(
      repo,
      "src/index.ts",
      "export class Index {\n  lookup(k: string) {\n    return `${k}`;\n  }\n}\n",
    );
    write(repo, "src/util.test.ts", "limit test\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "fix: limit");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const snapshot = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const rel of ["src/util.ts", "src/added/helper.ts", "src/obsolete.ts"]) {
      const abs = path.join(repo, rel);
      out[rel] = fs.existsSync(abs) ? fs.readFileSync(abs).toString("base64") : "<absent>";
    }
    return out;
  };

  /** Passes only when the fix is present, and records what the tree looked like. */
  const fixAwareRunner =
    (seen: string[][]): TestRunner =>
    async (cwd, tests) => {
      const util = fs.readFileSync(path.join(repo, "src/util.ts"), "utf8");
      seen.push([
        path.relative(repo, cwd),
        ...tests,
        String(fs.existsSync(path.join(repo, "src/added"))),
      ]);
      return { code: util.includes("Math.min") ? 0 : 1, output: "1 failed" };
    };

  it("lists callers outside the diff and skips the revert check with --head", async () => {
    run(repo, "checkout", "-q", "master");
    const report = await runPreflight({ checkout: repo, base: "master", head: "fix" });
    const callers = report.checks.find((c) => c.id === "callers");
    expect(callers?.status).toBe("warn");
    const text = callers?.details.join("\n") ?? "";
    expect(text).toContain("limit [function] src/util.ts:1");
    expect(text).toContain("src/caller.ts:1:");
    expect(text).toContain("tests: extensions/ext/index.test.ts");
    expect(text).toContain("no references outside the diff: helper, Index.lookup, obsolete");
    expect(report.checks.find((c) => c.id === "revert")?.status).toBe("skip");
    expect(report.checks.find((c) => c.id === "comments")?.details[0]).toContain(
      "src/added/helper.ts:1",
    );
    expect(report.passed).toBe(true);
  });

  it("reverts non-test files, expects failure, and restores the branch byte for byte", async () => {
    const before = snapshot();
    const seen: string[][] = [];
    const report = await runPreflight({
      checkout: repo,
      base: "master",
      runner: fixAwareRunner(seen),
    });
    const revert = report.checks.find((c) => c.id === "revert");
    expect(revert?.status).toBe("pass");
    // Branch run, then reverted run: helper dir removed, test file kept.
    expect(seen).toEqual([
      ["", "src/util.test.ts", "true"],
      ["", "src/util.test.ts", "false"],
    ]);
    expect(snapshot()).toEqual(before);
    expect(run(repo, "status", "--porcelain")).toBe("");
  });

  it("fails when the tests still pass with the fix reverted", async () => {
    const report = await runPreflight({
      checkout: repo,
      base: "master",
      runner: async () => ({ code: 0, output: "ok" }),
    });
    expect(report.checks.find((c) => c.id === "revert")?.status).toBe("fail");
    expect(report.passed).toBe(false);
  });

  it("restores the branch when the test runner throws", async () => {
    const before = snapshot();
    let calls = 0;
    const runner: TestRunner = async () => {
      if (++calls === 2) throw new Error("killed");
      return { code: 0, output: "" };
    };
    await expect(runPreflight({ checkout: repo, base: "master", runner })).rejects.toThrow(
      "killed",
    );
    expect(snapshot()).toEqual(before);
    expect(run(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses to revert on a dirty tree", async () => {
    write(repo, "src/caller.ts", "changed\n");
    const report = await runPreflight({
      checkout: repo,
      base: "master",
      runner: () => Promise.reject(new Error("must not run")),
    });
    const revert = report.checks.find((c) => c.id === "revert");
    expect(revert?.status).toBe("fail");
    expect(revert?.summary).toContain("uncommitted changes");
    expect(fs.readFileSync(path.join(repo, "src/caller.ts"), "utf8")).toBe("changed\n");
  });

  it("lints the PR through an injected fetcher", async () => {
    const report = await runPreflight({
      checkout: repo,
      base: "master",
      skipRevert: true,
      pr: "1",
      fetchPullRequest: async () => ({ title: "wip", body: "", headRefOid: "0".repeat(40) }),
    });
    expect(report.checks.find((c) => c.id === "description")?.status).toBe("fail");
    expect(report.passed).toBe(false);
  });
});
