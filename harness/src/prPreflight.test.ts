import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  actionTypeOf,
  assignedFields,
  commentText,
  computeSize,
  declaresOwnMember,
  defaultExportMentions,
  dispatchUse,
  exportedNames,
  filterMemberHits,
  importTargets,
  lintPullRequest,
  measurementsInComments,
  memberUse,
  parseImports,
  parseUnifiedDiff,
  resolveTestPath,
  runPreflight,
  sizeCheck,
  stateReaders,
  touchedReducers,
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

describe("member uses", () => {
  it("counts member access and JSX attributes, not bare words or spreads", () => {
    expect(memberUse("driver.renderRow(x)", "renderRow")).toBe("member");
    expect(memberUse("this.renderRow", "renderRow")).toBe("member");
    expect(memberUse("a?.renderRow()", "renderRow")).toBe("member");
    expect(memberUse("items.map(renderRow)", "renderRow")).toBeUndefined();
    expect(memberUse("const x = { ...renderRow };", "renderRow")).toBeUndefined();
    expect(memberUse("<Table renderRow={x} />", "renderRow", "a.tsx")).toBe("jsx");
    expect(memberUse("<Table renderRow={x} />", "renderRow", "a.ts")).toBeUndefined();
    expect(memberUse("const renderRow = {", "renderRow", "a.tsx")).toBeUndefined();
  });

  it("recognises a class declaring its own member, not calls or locals", () => {
    expect(declaresOwnMember("  private renderRow = (): Node => {", "renderRow")).toBe(true);
    expect(declaresOwnMember("  renderRow(item: Item) {", "renderRow")).toBe(true);
    expect(declaresOwnMember("  public get step() {", "step")).toBe(true);
    expect(declaresOwnMember("    onScroll?.(event);", "onScroll")).toBe(false);
    expect(declaresOwnMember("    onScroll(event);", "onScroll")).toBe(false);
    expect(declaresOwnMember("const renderRow = () => 1;", "renderRow")).toBe(false);
    // git grep hits arrive trimmed
    expect(declaresOwnMember("private renderRow = () => 1;", "renderRow")).toBe(true);
  });

  it("drops another class's own member and its this.uses", () => {
    const hit = (file: string, text: string) => ({ file, line: 1, text });
    const { kept, dropped } = filterMemberHits(
      [
        hit("other.tsx", "  private renderRow = () => 1;"),
        hit("other.tsx", "return this.renderRow();"),
        hit("other.tsx", "return table.renderRow();"),
        hit("local.ts", "items.map(renderRow);"),
        hit("use.ts", "table.renderRow(1);"),
      ],
      "renderRow",
    );
    expect(kept.map((h) => `${h.file}: ${h.text}`)).toEqual([
      "other.tsx: return table.renderRow();",
      "use.ts: table.renderRow(1);",
    ]);
    expect(dropped).toBe(3);
    // A getter is read as `x.step`; `<Steps step={…}>` is some component's prop.
    const jsx = [hit("a.tsx", "<Steps step={n} />"), hit("b.ts", "if (driver.step) {")];
    expect(filterMemberHits(jsx, "step").kept).toHaveLength(2);
    expect(filterMemberHits(jsx, "step", { jsx: false }).kept.map((h) => h.file)).toEqual(["b.ts"]);
  });
});

describe("module consumers", () => {
  it("finds a default export that wraps a class, across lines", () => {
    const wrapped =
      'class A {}\n\nexport default translate(["x"])(\n  connect(m)(\n    A,\n  ),\n);\n';
    expect(defaultExportMentions(wrapped, "A")).toBe(true);
    expect(defaultExportMentions("export default class A {}", "A")).toBe(true);
    expect(defaultExportMentions("export { A as default };", "A")).toBe(true);
    expect(defaultExportMentions("export default B;\nconst A = 1;\nfoo(A);", "A")).toBe(false);
  });

  it("parses default, named, type and re-export bindings", () => {
    const imports = parseImports(
      [
        'import Table, { type Row, makeRow as mk } from "./Table";',
        'import type { Other } from "./Other";',
        "import {\n  ComponentEx,\n  Table as T,\n} from 'vortex-api';",
        'import * as ns from "./ns";',
        'export { default as Widget, helper } from "./Widget";',
      ].join("\n"),
    );
    expect(imports).toEqual([
      {
        spec: "./Table",
        defaultName: "Table",
        namespace: undefined,
        named: [
          { imported: "Row", local: "Row" },
          { imported: "makeRow", local: "mk" },
        ],
        typeOnly: false,
        reexport: false,
      },
      {
        spec: "./Other",
        defaultName: undefined,
        namespace: undefined,
        named: [{ imported: "Other", local: "Other" }],
        typeOnly: true,
        reexport: false,
      },
      {
        spec: "vortex-api",
        defaultName: undefined,
        namespace: undefined,
        named: [
          { imported: "ComponentEx", local: "ComponentEx" },
          { imported: "Table", local: "T" },
        ],
        typeOnly: false,
        reexport: false,
      },
      {
        spec: "./ns",
        defaultName: undefined,
        namespace: "ns",
        named: [],
        typeOnly: false,
        reexport: false,
      },
      {
        spec: "./Widget",
        named: [
          { imported: "default", local: "Widget" },
          { imported: "helper", local: "helper" },
        ],
        typeOnly: false,
        reexport: true,
      },
    ]);
  });

  it("resolves relative and alias specs to the module", () => {
    const target = "src/renderer/src/controls/Table.tsx";
    expect(importTargets("src/renderer/src/views/A.tsx", "../controls/Table", target)).toBe(true);
    expect(importTargets("src/renderer/src/views/A.tsx", "@/controls/Table", target)).toBe(true);
    expect(importTargets("src/renderer/src/views/A.tsx", "../ui/Table", target)).toBe(false);
    expect(importTargets("src/renderer/src/views/A.tsx", "react", target)).toBe(false);
    expect(importTargets("src/a/b.ts", "../util", "src/util/index.ts")).toBe(true);
  });

  it("reads the names a barrel exports a binding under", () => {
    const barrel =
      'import Table from "./Table";\n\nexport {\n  Spinner,\n  Table,\n  Table as Grid,\n};\n';
    expect(exportedNames(barrel, "Table")).toEqual(["Table", "Grid"]);
    expect(exportedNames('export { Table } from "./x";', "Table")).toEqual([]);
  });
});

describe("state readers", () => {
  it("finds the fields a line assigns", () => {
    expect(assignedFields('this.mStep = "start";')).toEqual(["mStep"]);
    expect(assignedFields("this.mCount += 1; this.mOther++; --this.mLast;").toSorted()).toEqual([
      "mCount",
      "mLast",
      "mOther",
    ]);
    expect(assignedFields('if (this.mStep === "start") {')).toEqual([]);
  });

  it("lists reads, not writes or comments", () => {
    const content = [
      "class A {",
      "  get step() {",
      "    return this.mStep;",
      "  }",
      "  go() {",
      '    this.mStep = "x";',
      "    // this.mStep is read here",
      '    if (this.mStep === "y") this.mStepCount++;',
      "    this.mStep++;",
      "  }",
      "}",
    ].join("\n");
    expect(stateReaders(content, "mStep")).toEqual([3, 8]);
  });
});

describe("--test paths", () => {
  it("accepts paths from the checkout root or from --project-dir, and rejects others", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-paths-"));
    try {
      fs.mkdirSync(path.join(root, "src", "renderer", "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "renderer", "src", "a.test.ts"), "");
      expect(resolveTestPath(root, "src/renderer/src/a.test.ts")).toBe(
        "src/renderer/src/a.test.ts",
      );
      expect(resolveTestPath(root, "src/a.test.ts", "src/renderer")).toBe(
        "src/renderer/src/a.test.ts",
      );
      expect(resolveTestPath(root, path.join(root, "src/renderer/src/a.test.ts"))).toBe(
        "src/renderer/src/a.test.ts",
      );
      expect(() => resolveTestPath(root, "src/a.test.ts")).toThrow(/does not exist; tried/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe("runPreflight on a git checkout", { timeout: 60_000 }, () => {
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

  it("resolves --test from --project-dir and says where paths are relative to", async () => {
    write(repo, "pkg/package.json", "{}\n");
    write(repo, "pkg/src/x.test.ts", "x\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "test: pkg");
    const seen: string[][] = [];
    const report = await runPreflight({
      checkout: repo,
      base: "master",
      tests: ["src/x.test.ts"],
      projectDir: "pkg",
      runner: fixAwareRunner(seen),
    });
    const revert = report.checks.find((c) => c.id === "revert");
    expect(seen[0]?.slice(0, 2)).toEqual(["pkg", "src/x.test.ts"]);
    expect(revert?.details.join("\n")).toContain("in pkg (paths relative to it): src/x.test.ts");
    const missing = await runPreflight({
      checkout: repo,
      base: "master",
      tests: ["nowhere.test.ts"],
      runner: () => Promise.reject(new Error("must not run")),
    });
    expect(missing.checks.find((c) => c.id === "revert")?.summary).toContain("does not exist");
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

describe("callers of a class member and readers of its state", { timeout: 60_000 }, () => {
  let repo: string;
  const TABLE = (body: string, start: string) => `import React from "react";

class SuperTable extends React.Component {
  private mStep = "prepare";

  public get step() {
    return this.mStep;
  }

  public renderRow(id: string) {
    ${body}
  }

  public canContinue() {
    return this.mStep === "review";
  }

  public begin() {
    this.mStep = "${start}";
  }
}

export default translate(["common"])(
  SuperTable,
);
`;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-members-"));
    run(repo, "init", "-q", "-b", "master");
    run(repo, "config", "user.email", "test@example.test");
    run(repo, "config", "user.name", "Test");
    run(repo, "config", "core.autocrlf", "false");
    write(repo, "src/controls/Table.tsx", TABLE("return id;", "start"));
    write(repo, "src/controls/api.ts", 'import Table from "./Table";\n\nexport {\n  Table,\n};\n');
    write(repo, "src/views/ModList.tsx", 'import SuperTable from "../controls/Table";\n');
    write(repo, "src/views/Alias.tsx", 'import Grid from "@/controls/Table";\n');
    write(repo, "src/views/Types.ts", 'import type { IRow } from "../controls/Table";\n');
    write(repo, "src/views/Use.ts", 'export const cell = grid.renderRow("a");\n');
    write(
      repo,
      "extensions/ext/src/view.tsx",
      'import {\n  ComponentEx,\n  Table,\n} from "@nexusmods/vortex-api";\n\nexport const V = () => <Table renderRow={x} />;\n',
    );
    write(
      repo,
      "extensions/other/src/other.tsx",
      [
        "class Other {",
        "  private renderRow = () => 1;",
        "  public go() {",
        "    return this.renderRow();",
        "  }",
        "}",
        "const renderRow = () => 2;",
        "[1].map(renderRow);",
        "export const now = driver.step;",
        "",
      ].join("\n"),
    );
    run(repo, "add", ".");
    run(repo, "commit", "-q", "-m", "base");
    run(repo, "checkout", "-q", "-b", "fix");
    write(repo, "src/controls/Table.tsx", TABLE("return `${id}`;", "installing"));
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "fix: rows");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("searches members as members and lists the default export's consumers", async () => {
    const report = await runPreflight({ checkout: repo, base: "master", skipRevert: true });
    const text = report.checks.find((c) => c.id === "callers")?.details.join("\n") ?? "";
    expect(text).toContain(
      "SuperTable.renderRow [method] src/controls/Table.tsx:10: 2 references in 2 files " +
        "(5 bare-name, other-class or declaration hits left out)",
    );
    expect(text).toContain("src/views/Use.ts:1:");
    expect(text).toContain("extensions/ext/src/view.tsx:6:");
    expect(text).not.toContain("other.tsx");
    expect(text).toContain(
      "consumers of SuperTable (src/controls/Table.tsx, encloses the touched renderRow, begin)",
    );
    expect(text).toContain(
      "default export imported by 3 files: src/controls/api.ts (as Table), " +
        "src/views/Alias.tsx (as Grid), src/views/ModList.tsx (as SuperTable)",
    );
    expect(text).toContain(
      "re-exported as Table by src/controls/api.ts; imported from there or vortex-api by 1 files: " +
        "extensions/ext/src/view.tsx",
    );
  });

  it("lists the readers of a field whose assignment changed, and the getter's uses", async () => {
    const report = await runPreflight({ checkout: repo, base: "master", skipRevert: true });
    const state = report.checks.find((c) => c.id === "state");
    expect(state?.status).toBe("warn");
    const text = state?.details.join("\n") ?? "";
    expect(text).toContain("this.mStep is assigned by the diff and read by 2 members");
    expect(text).toContain("SuperTable.step (line 7): return this.mStep;");
    expect(text).toContain('SuperTable.canContinue (line 15): return this.mStep === "review";');
    expect(text).toContain("getter step: 1 uses outside the diff");
    expect(text).toContain("extensions/other/src/other.tsx:9: export const now = driver.step;");
  });
});

const REDUCER = `import * as actions from "../actions/mods";
import { referenceEqual } from "../util/ref";

export const modsReducer = {
  reducers: {
    [actions.setModName as any]: (state, payload) => {
      return { ...state, name: payload.name };
    },
    [actions.addModRule as any]: (state, payload) => {
      const existing = state.rules ?? [];
      return { ...state, rules: [...existing, payload.rule] };
    },
  },
  defaults: {},
};

export function hasRule(rules, rule) {
  return rules.some((r) => referenceEqual(r, rule));
}
`;

describe("reducer handlers and their dispatchers", () => {
  const at = (text: string): number => REDUCER.split("\n").findIndex((l) => l.includes(text)) + 1;

  it("finds the handler enclosing a changed line, and none outside the handler map", () => {
    expect(touchedReducers(REDUCER, [at("const existing")], "r.ts")).toEqual([
      { action: "addModRule", file: "r.ts", line: at("[actions.addModRule") },
    ]);
    expect(touchedReducers(REDUCER, [at("[actions.setModName")], "r.ts")[0]?.action).toBe(
      "setModName",
    );
    expect(touchedReducers(REDUCER, [at("rules.some")], "r.ts")).toEqual([]);
    expect(touchedReducers(REDUCER, [at("defaults")], "r.ts")).toEqual([]);
  });

  it("tells a creator's definition and calls from imports, keys and mentions", () => {
    expect(dispatchUse("export const addModRule = safeCreateAction(", "addModRule")).toBe(
      "definition",
    );
    expect(
      dispatchUse("api.store.dispatch(actions.addModRule(gameId, id, rule));", "addModRule"),
    ).toBe("call");
    expect(dispatchUse("onAdd: (r) => dispatch(addModRule(g, m, r)),", "addModRule")).toBe("call");
    expect(dispatchUse("[actions.addModRule as any]: (state, payload) => {", "addModRule")).toBe(
      undefined,
    );
    expect(dispatchUse("  addModRule,", "addModRule")).toBeUndefined();
    expect(dispatchUse("import { addModRule } from './actions';", "addModRule")).toBeUndefined();
  });

  it("reads the action type a creator is defined with, across lines", () => {
    expect(
      actionTypeOf(
        'export const addModRule = safeCreateAction(\n  "ADD_MOD_RULE",\n  (a) => ({ a }),\n);',
        "addModRule",
      ),
    ).toBe("ADD_MOD_RULE");
    expect(actionTypeOf("export const other = 1;", "addModRule")).toBeUndefined();
  });
});

describe(
  "callers in changed files and dispatchers of a changed reducer",
  { timeout: 60_000 },
  () => {
    let repo: string;
    const INSTALLER = (body: string, extra: string) => `import { referenceEqual } from "./util/ref";
import * as actions from "./actions/mods";

class Installer {
  private helper(rule) {
    ${body}
  }

  public install(api, rule) {
    if (referenceEqual(rule, rule)) return;
    api.store.dispatch(actions.addModRule("game", "mod", rule));
    return this.helper(rule);
  }
}

export function run() {
  ${extra}
}
`;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-dispatch-"));
      run(repo, "init", "-q", "-b", "master");
      run(repo, "config", "user.email", "test@example.test");
      run(repo, "config", "user.name", "Test");
      run(repo, "config", "core.autocrlf", "false");
      write(
        repo,
        "src/util/ref.ts",
        "export function referenceEqual(a, b) {\n  return a === b;\n}\n",
      );
      write(
        repo,
        "src/actions/mods.ts",
        'export const addModRule = safeCreateAction(\n  "ADD_MOD_RULE",\n  (gameId, modId, rule) => ({ gameId, modId, rule }),\n);\n' +
          'export const setModName = safeCreateAction("SET_MOD_NAME", (name) => ({ name }));\n',
      );
      write(repo, "src/reducers/mods.ts", REDUCER);
      write(repo, "src/installer.ts", INSTALLER("return rule;", "return 1;"));
      write(
        repo,
        "extensions/ext/src/index.ts",
        'import { actions } from "vortex-api";\n' +
          "export const go = (api) => api.store.dispatch(actions.addModRule(1, 2, 3));\n" +
          'export const raw = { type: "ADD_MOD_RULE", payload: {} };\n',
      );
      run(repo, "add", ".");
      run(repo, "commit", "-q", "-m", "base");
      run(repo, "checkout", "-q", "-b", "fix");
      write(
        repo,
        "src/util/ref.ts",
        "export function referenceEqual(a, b) {\n  return a.id === b.id;\n}\n",
      );
      write(
        repo,
        "src/reducers/mods.ts",
        REDUCER.replace(
          "const existing = state.rules ?? [];",
          "const existing = state.rules || [];",
        ),
      );
      write(repo, "src/installer.ts", INSTALLER("return { ...rule };", "return 2;"));
      run(repo, "add", "-A");
      run(repo, "commit", "-q", "-m", "fix: rules");
    });

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true });
    });

    it("lists callers in changed files outside their hunks, and the class's own this.uses", async () => {
      const report = await runPreflight({ checkout: repo, base: "master", skipRevert: true });
      const text = report.checks.find((c) => c.id === "callers")?.details.join("\n") ?? "";
      // Both files are in the diff; neither call is on a changed line.
      expect(text).toContain(
        "referenceEqual [function] src/util/ref.ts:1: 4 references in 2 files; 4 in changed files, outside their hunks",
      );
      expect(text).toContain("src/installer.ts:10: if (referenceEqual(rule, rule)) return;");
      expect(text).toContain("src/reducers/mods.ts:18: return rules.some");
      // Nothing outside the file reaches Installer, but its own install() calls helper().
      expect(text).toContain(
        "Installer.helper [method] src/installer.ts:5: 1 references in 1 files",
      );
      expect(text).toContain("src/installer.ts:12: return this.helper(rule);");
    });

    it("lists every dispatch of an action whose reducer changed, extensions and type strings too", async () => {
      const report = await runPreflight({ checkout: repo, base: "master", skipRevert: true });
      const check = report.checks.find((c) => c.id === "dispatch");
      expect(check?.status).toBe("warn");
      const text = check?.details.join("\n") ?? "";
      expect(text).toContain(
        "addModRule (ADD_MOD_RULE): reducer at src/reducers/mods.ts:9; 2 dispatch sites in 2 files, 1 in extensions",
      );
      expect(text).toContain("created at src/actions/mods.ts:1:");
      expect(text).toContain("src/installer.ts:11: api.store.dispatch(actions.addModRule(");
      expect(text).toContain("extensions/ext/src/index.ts:2:");
      expect(text).toContain("by type string ADD_MOD_RULE: 1 lines");
      expect(text).toContain(
        'extensions/ext/src/index.ts:3: export const raw = { type: "ADD_MOD_RULE"',
      );
      expect(text).not.toContain("setModName");
    });
  },
);
