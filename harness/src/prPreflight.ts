/**
 * `pr-preflight`: the mechanical checks a Vortex fix agent runs on its branch
 * before pushing, so the adversarial review only has to judge what a script
 * can't (see harness/PULL-REQUESTS.md, "Getting it right before review").
 *
 * Everything here reads the checkout through git and never changes it, with
 * one exception: the revert check (negative control) temporarily restores the
 * non-test files to the base version, runs the tests, and puts the branch's
 * exact bytes back. It refuses to start on a dirty tree, keeps a backup outside
 * the checkout, restores on throw and on Ctrl+C, and verifies hashes and
 * `git status` afterwards.
 *
 * The pure parts (diff parsing, size, symbol extraction, comment scan, PR
 * description lint) are exported for unit tests. Symbol extraction is a
 * deliberately simple indentation-and-regex heuristic over the declarations
 * enclosing each changed line; its limits are listed on `touchedSymbols`.
 */
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { LeaseHeldError, checkoutResource, resolveOwner, withLeases } from "./lease";
import { UPSTREAM, childEnv } from "./source";

const execFileAsync = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: "size" | "callers" | "revert" | "comments" | "description";
  title: string;
  status: CheckStatus;
  summary: string;
  details: string[];
  /** Full machine-readable detail, for `--json` (for example every caller hit). */
  data?: Record<string, unknown>;
}

export interface PreflightReport {
  checkout: string;
  base: string;
  head: string;
  headSha: string;
  mergeBase: string;
  notes: string[];
  checks: CheckResult[];
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

export interface DiffLine {
  line: number;
  text: string;
}

export interface FileDiff {
  /** Path on the head side, or the base path when the file was deleted. */
  path: string;
  oldPath?: string;
  newPath?: string;
  binary: boolean;
  added: DiffLine[];
  removed: DiffLine[];
}

function unquoteGitPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  // core.quotePath=false leaves only quotes and backslash escapes to undo.
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

function stripPrefix(raw: string, prefix: "a/" | "b/"): string | undefined {
  const value = unquoteGitPath(raw);
  if (value === "/dev/null") return undefined;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Parse `git diff` output (any context size, `a/`/`b/` prefixes) into per-file changes. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const finish = (): void => {
    if (current === undefined) return;
    current.path = current.newPath ?? current.oldPath ?? current.path;
    files.push(current);
    current = undefined;
  };

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      finish();
      inHunk = false;
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      const guess = match?.[2] ?? "";
      current = {
        path: guess,
        oldPath: match?.[1],
        newPath: guess,
        binary: false,
        added: [],
        removed: [],
      };
      continue;
    }
    if (current === undefined) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (inHunk) {
      if (line.startsWith("+")) current.added.push({ line: newLine++, text: line.slice(1) });
      else if (line.startsWith("-")) current.removed.push({ line: oldLine++, text: line.slice(1) });
      else if (line.startsWith(" ")) {
        oldLine++;
        newLine++;
      }
      continue;
    }
    if (line.startsWith("--- ")) current.oldPath = stripPrefix(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) current.newPath = stripPrefix(line.slice(4), "b/");
    else if (line.startsWith("new file mode")) current.oldPath = undefined;
    else if (line.startsWith("deleted file mode")) current.newPath = undefined;
    else if (line.startsWith("rename from ")) current.oldPath = unquoteGitPath(line.slice(12));
    else if (line.startsWith("rename to ")) current.newPath = unquoteGitPath(line.slice(10));
    else if (line.startsWith("Binary files ")) current.binary = true;
  }
  finish();
  return files;
}

// ---------------------------------------------------------------------------
// Classification and size
// ---------------------------------------------------------------------------

const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__|__fixtures__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file.replace(/\\/g, "/"));
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|mts|cts)$/;

/** Files CONTRIBUTING.md tells reviewers to ignore when sizing a PR. */
const SIZE_EXCLUDED = [
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/,
  /(?:^|\/)etc\/[^/]+\.api\.md$/,
  /(?:^|\/)__snapshots__\//,
  /\.snap$/,
  /\.min\.(?:js|css)$/,
  /(?:^|\/)(?:dist|out|build)\//,
  /\.generated\.[^/]+$/,
];

export function isSizeExcluded(file: string): boolean {
  const normal = file.replace(/\\/g, "/");
  return SIZE_EXCLUDED.some((pattern) => pattern.test(normal));
}

export const SIZE_LIMIT = { lines: 400, files: 10 };

export interface SizeSummary {
  lines: number;
  files: number;
  added: number;
  removed: number;
  excluded: string[];
}

export function computeSize(files: FileDiff[]): SizeSummary {
  const summary: SizeSummary = { lines: 0, files: 0, added: 0, removed: 0, excluded: [] };
  for (const file of files) {
    if (isSizeExcluded(file.path)) {
      summary.excluded.push(file.path);
      continue;
    }
    summary.files++;
    summary.added += file.added.length;
    summary.removed += file.removed.length;
  }
  summary.lines = summary.added + summary.removed;
  return summary;
}

export function sizeCheck(files: FileDiff[]): CheckResult {
  const size = computeSize(files);
  const over = size.lines > SIZE_LIMIT.lines || size.files > SIZE_LIMIT.files;
  const details = files
    .filter((file) => !isSizeExcluded(file.path))
    .map((file) => `${file.path}: +${file.added.length} -${file.removed.length}`);
  if (size.excluded.length > 0) details.push(`excluded: ${size.excluded.join(", ")}`);
  if (over) {
    details.push(
      "CONTRIBUTING.md asks for about 400 lines across 10 files unless a maintainer agreed to " +
        "more. Split it, or say in the PR who agreed.",
    );
  }
  return {
    id: "size",
    title: "Size",
    status: over ? "warn" : "pass",
    summary:
      `${String(size.lines)} changed lines (+${String(size.added)} -${String(size.removed)}) ` +
      `in ${String(size.files)} files (limit ${String(SIZE_LIMIT.lines)} lines, ` +
      `${String(SIZE_LIMIT.files)} files)`,
    details,
  };
}

// ---------------------------------------------------------------------------
// Symbols touched by the diff
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "function"
  | "component"
  | "const"
  | "class"
  | "method"
  | "property"
  | "type";

export interface TouchedSymbol {
  name: string;
  kind: SymbolKind;
  /** File and line of the declaration, on the side of the diff it was found. */
  file: string;
  line: number;
  side: "head" | "base";
  className?: string;
}

interface ParsedLine {
  indent: number;
  decl?: { name: string; kind: SymbolKind; exported: boolean };
  memberName?: string;
  isClass: boolean;
}

const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "catch",
  "try",
  "finally",
  "return",
  "throw",
  "new",
  "await",
  "yield",
  "typeof",
  "delete",
  "void",
  "super",
  "this",
  "function",
  "const",
  "let",
  "var",
  "import",
  "export",
]);

const FUNCTION_DECL =
  /^(\s*)(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const CLASS_DECL =
  /^(\s*)(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TYPE_DECL =
  /^(\s*)(export\s+)?(?:default\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const VARIABLE_DECL = /^(\s*)(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const MEMBER_DECL =
  /^(\s+)(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*[(=:?!]/;

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

function parseLine(line: string): ParsedLine {
  const indent = indentOf(line);
  const fn = FUNCTION_DECL.exec(line);
  if (fn?.[3] !== undefined) {
    const kind = /^[A-Z]/.test(fn[3]) ? "component" : "function";
    return { indent, isClass: false, decl: { name: fn[3], kind, exported: fn[2] !== undefined } };
  }
  const cls = CLASS_DECL.exec(line);
  if (cls?.[3] !== undefined) {
    return {
      indent,
      isClass: true,
      decl: { name: cls[3], kind: "class", exported: cls[2] !== undefined },
    };
  }
  const type = TYPE_DECL.exec(line);
  if (type?.[3] !== undefined) {
    return {
      indent,
      isClass: false,
      decl: { name: type[3], kind: "type", exported: type[2] !== undefined },
    };
  }
  const variable = VARIABLE_DECL.exec(line);
  if (variable?.[3] !== undefined) {
    const name = variable[3];
    const kind =
      /^[A-Z]/.test(name) && /=>|\bReact\b|memo\(|forwardRef/.test(line) ? "component" : "const";
    return { indent, isClass: false, decl: { name, kind, exported: variable[2] !== undefined } };
  }
  const member = MEMBER_DECL.exec(line);
  if (member?.[2] !== undefined && !KEYWORDS.has(member[2])) {
    return { indent, isClass: false, memberName: member[2] };
  }
  return { indent, isClass: false };
}

function memberKind(line: string, name: string): "method" | "property" {
  const after = line.slice(line.indexOf(name) + name.length);
  if (/^\s*(?:<[^>]*>)?\s*\(/.test(after)) return "method";
  if (/^\s*[?!]?\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\(|[\w$]+\s*=>|function\b)/.test(after)) {
    return "method";
  }
  return "property";
}

function exportedByName(content: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, "\\$");
  return (
    new RegExp(`^export\\s+(?:type\\s+)?\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "m").test(content) ||
    new RegExp(`^export\\s+default\\b.*\\b${escaped}\\b`, "m").test(content) ||
    new RegExp(`^export\\s*=\\s*${escaped}\\b`, "m").test(content) ||
    new RegExp(`module\\.exports(?:\\.\\w+)?\\s*=.*\\b${escaped}\\b`).test(content)
  );
}

/**
 * The exported or class-member declarations enclosing the given (1-based) lines.
 *
 * Walks upward from each line through strictly less-indented lines, which
 * gives the chain of enclosing blocks, and reports the innermost element that
 * is a member of a class or an exported top-level declaration. A changed
 * `constructor` reports its class, since callers reference the class.
 *
 * Limits: relies on conventional indentation (the formatter guarantees it in
 * Vortex); a top-level declaration counts as exported only through `export`
 * on its line, `export { name }`, `export default ...name`, or
 * `module.exports`; object-literal methods and re-exports under another name
 * are not followed; local helpers inside an exported function report that
 * function.
 */
export function touchedSymbols(
  content: string,
  lines: number[],
  file: string,
  side: "head" | "base",
): TouchedSymbol[] {
  const source = content.split(/\r?\n/);
  const parsed = new Map<number, ParsedLine>();
  const parse = (index: number): ParsedLine => {
    let value = parsed.get(index);
    if (value === undefined) {
      value = parseLine(source[index] ?? "");
      parsed.set(index, value);
    }
    return value;
  };
  const found = new Map<string, TouchedSymbol>();

  for (const lineNumber of lines) {
    const start = lineNumber - 1;
    const text = source[start];
    if (text === undefined || text.trim() === "") continue;

    const chain: { index: number; parsed: ParsedLine }[] = [];
    const own = parse(start);
    let threshold = own.indent;
    if (own.decl !== undefined || own.memberName !== undefined)
      chain.push({ index: start, parsed: own });
    // A closing bracket at a declaration's indent still belongs to it.
    if (/^\s*[}\])]/.test(text)) threshold = own.indent + 1;
    for (let index = start - 1; index >= 0 && threshold > 0; index--) {
      const candidate = source[index] ?? "";
      if (candidate.trim() === "") continue;
      const info = parse(index);
      if (info.indent >= threshold) continue;
      // Comments and decorators at a lower indent don't open blocks.
      if (/^\s*(?:\/\/|\/\*|\*|@)/.test(candidate)) continue;
      // `): Type {` or `} else {` continues a block opened higher up at the same indent.
      if (/^\s*[}\])]/.test(candidate)) {
        threshold = info.indent + 1;
        continue;
      }
      chain.push({ index, parsed: info });
      threshold = info.indent;
    }

    for (let i = 0; i < chain.length; i++) {
      const element = chain[i];
      if (element === undefined) continue;
      const parent = chain[i + 1];
      const { decl, memberName, indent } = element.parsed;
      if (parent?.parsed.isClass === true && parent.parsed.decl !== undefined) {
        const name = memberName ?? decl?.name;
        if (name === undefined) continue;
        const className = parent.parsed.decl.name;
        const symbol: TouchedSymbol =
          name === "constructor"
            ? { name: className, kind: "class", file, line: parent.index + 1, side }
            : {
                name,
                kind: memberKind(source[element.index] ?? "", name),
                file,
                line: element.index + 1,
                side,
                className,
              };
        found.set(`${symbol.className ?? ""}#${symbol.name}`, symbol);
        break;
      }
      if (indent === 0 && decl !== undefined) {
        if (decl.exported || exportedByName(content, decl.name)) {
          found.set(`#${decl.name}`, {
            name: decl.name,
            kind: decl.kind,
            file,
            line: element.index + 1,
            side,
          });
        }
        break;
      }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Measurements in comments
// ---------------------------------------------------------------------------

const MEASUREMENT =
  /\b\d+(?:[.,]\d+)?\s?(?:ms|s|secs?|seconds?|mins?|minutes?|hours?|h|x|×|%|[KMG]i?B|bytes|fps)(?![\w])|\bfrom\s+[~≈]?\d[\d.,]*\s*\S*\s+(?:to|->|→)\s+[~≈]?\d/i;

/** The comment part of a source line, or undefined when it has none. */
export function commentText(line: string): string | undefined {
  const trimmed = line.trim();
  if (/^(?:\/\/|\/\*|\*|\{\s*\/\*)/.test(trimmed)) return trimmed;
  // A trailing `//` not part of a URL (`https://`).
  const trailing = /(?:^|[^:\\/'"`])\/\/(.*)$/.exec(line);
  if (trailing?.[1] !== undefined) return trailing[1];
  const block = /\/\*(.*?)(?:\*\/|$)/.exec(line);
  return block?.[1];
}

export interface CommentFinding {
  file: string;
  line: number;
  text: string;
}

export function measurementsInComments(files: FileDiff[]): CommentFinding[] {
  const findings: CommentFinding[] = [];
  for (const file of files) {
    if (file.newPath === undefined || !CODE_FILE.test(file.newPath)) continue;
    for (const added of file.added) {
      const comment = commentText(added.text);
      if (comment !== undefined && MEASUREMENT.test(comment)) {
        findings.push({ file: file.newPath, line: added.line, text: added.text.trim() });
      }
    }
  }
  return findings;
}

export function commentCheck(files: FileDiff[]): CheckResult {
  const findings = measurementsInComments(files);
  return {
    id: "comments",
    title: "Measurements in comments",
    status: findings.length === 0 ? "pass" : "warn",
    summary:
      findings.length === 0
        ? "no timing or size figures in added comments"
        : `${String(findings.length)} added comment lines contain figures; numbers belong in the PR`,
    details: findings.map((f) => `${f.file}:${String(f.line)}: ${truncate(f.text)}`),
  };
}

// ---------------------------------------------------------------------------
// PR description
// ---------------------------------------------------------------------------

export const REQUIRED_SECTIONS = [
  "Problem",
  "Change",
  "Behaviour changes",
  "Evidence",
  "Review",
  "Not covered",
];

const CONVENTIONAL_TITLE =
  /^(?:feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert)(?:\([\w./, -]+\))?!?: \S/;

export interface PullRequestText {
  title: string;
  body: string;
  headRefOid: string;
  url?: string;
}

interface Section {
  heading: string;
  body: string;
}

function sections(body: string): Section[] {
  const result: (Section & { level: number })[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    // A section's body runs to the next heading of the same or a higher level,
    // so `### A/B` under `## Evidence` still counts as evidence.
    for (const open of result) {
      if (open.level === 0) continue;
      if (heading === null || (heading[1]?.length ?? 0) > open.level) open.body += `${line}\n`;
      else open.level = 0;
    }
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      result.push({ heading: heading[2].trim(), body: "", level: heading[1].length });
    }
  }
  return result;
}

function normalHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

export function lintPullRequest(pr: PullRequestText, localHead?: string): CheckResult {
  const fails: string[] = [];
  const warns: string[] = [];
  const title = pr.title.trim();

  if (!CONVENTIONAL_TITLE.test(title)) {
    fails.push(`title is not Conventional Commits (type(scope): summary): "${title}"`);
  }
  if (title.length > 72) fails.push(`title is ${String(title.length)} characters; keep it <= 72`);
  if (title.endsWith(".")) warns.push("title ends with a full stop");

  const found = sections(pr.body);
  const positions = REQUIRED_SECTIONS.map((name) =>
    found.findIndex((section) => normalHeading(section.heading) === normalHeading(name)),
  );
  REQUIRED_SECTIONS.forEach((name, i) => {
    if (positions[i] === -1) fails.push(`missing section "## ${name}"`);
  });
  const present = positions.filter((p) => p !== -1);
  if (present.some((p, i) => i > 0 && p < (present[i - 1] ?? 0))) {
    warns.push(`sections are out of order; expected ${REQUIRED_SECTIONS.join(", ")}`);
  }

  pr.body.split(/\r?\n/).forEach((line, i) => {
    if (/\bnot\s+run\b/i.test(line)) {
      fails.push(
        `body line ${String(i + 1)} says "Not run"; name what blocked it: ${truncate(line.trim())}`,
      );
    }
  });

  const head = pr.headRefOid.toLowerCase();
  const shas = pr.body.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
  if (!shas.some((sha) => head.startsWith(sha.toLowerCase()))) {
    fails.push(`body does not mention the head commit ${head.slice(0, 7)}; update the evidence`);
  }
  if (localHead !== undefined && localHead.toLowerCase() !== head) {
    warns.push(
      `PR head ${head.slice(0, 7)} differs from the checked head ${localHead.slice(0, 7)}; ` +
        "push, or check the PR's branch",
    );
  }

  const evidence = found.find((section) => normalHeading(section.heading) === "evidence");
  if (evidence !== undefined) {
    if (!/\bverify\b/i.test(evidence.body))
      warns.push("Evidence does not mention `pnpm run verify`");
    if (!/\be2e\b/i.test(evidence.body)) warns.push("Evidence does not mention E2E results");
  }

  const status: CheckStatus = fails.length > 0 ? "fail" : warns.length > 0 ? "warn" : "pass";
  return {
    id: "description",
    title: "PR description",
    status,
    summary:
      status === "pass"
        ? `title and body follow PULL-REQUESTS.md (${pr.url ?? "PR"})`
        : `${String(fails.length)} problems, ${String(warns.length)} warnings (${pr.url ?? "PR"})`,
    details: [...fails, ...warns.map((w) => `warn: ${w}`)],
  };
}

// ---------------------------------------------------------------------------
// Git access
// ---------------------------------------------------------------------------

export async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", dir, "-c", "core.quotePath=false", ...args],
    { windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
  );
  return stdout;
}

export async function gitBuffer(dir: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout;
}

export async function gitOk(dir: string, args: string[]): Promise<boolean> {
  try {
    await git(dir, args);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommit(dir: string, ref: string): Promise<string> {
  try {
    return (await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  } catch {
    throw new PreflightError(
      `${ref} is not a commit in ${dir}. Fetch it first (for example \`git fetch upstream\`).`,
    );
  }
}

export class PreflightError extends Error {}

const CALLER_ROOTS = ["src", "extensions"];
/** Names so generic that a word search lists half the codebase. */
const GENERIC_NAMES = new Set([
  "render",
  "constructor",
  "componentDidMount",
  "componentWillUnmount",
  "componentDidUpdate",
  "shouldComponentUpdate",
  "UNSAFE_componentWillReceiveProps",
  "getDerivedStateFromProps",
  "mapStateToProps",
  "mapDispatchToProps",
  "props",
  "state",
  "context",
  "init",
  "main",
  "default",
  "name",
  "id",
  "type",
  // Common method names: a member called this matches every array, map and promise.
  "find",
  "get",
  "set",
  "has",
  "add",
  "delete",
  "clear",
  "map",
  "filter",
  "forEach",
  "reduce",
  "push",
  "keys",
  "values",
  "entries",
  "then",
  "update",
  "remove",
  "start",
  "stop",
  "run",
  "open",
  "close",
  "reset",
  "toString",
  "toJSON",
  "length",
  "size",
  "value",
]);

export interface CallerHit {
  file: string;
  line: number;
  text: string;
}

export async function findReferences(
  dir: string,
  commit: string,
  name: string,
  roots = CALLER_ROOTS,
): Promise<CallerHit[]> {
  let out: string;
  try {
    out = await git(dir, ["grep", "-n", "-w", "-F", "-I", "-e", name, commit, "--", ...roots]);
  } catch (err) {
    // `git grep` exits 1 when nothing matches.
    if ((err as { code?: number }).code === 1) return [];
    throw err;
  }
  const prefix = `${commit}:`;
  const hits: CallerHit[] = [];
  for (const raw of out.split("\n")) {
    if (raw === "") continue;
    const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const match = /^(.*?):(\d+):(.*)$/.exec(rest);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    hits.push({ file: match[1], line: Number(match[2]), text: (match[3] ?? "").trim() });
  }
  return hits;
}

function truncate(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function symbolLabel(symbol: TouchedSymbol): string {
  const name = symbol.className === undefined ? symbol.name : `${symbol.className}.${symbol.name}`;
  const where = `${symbol.file}:${String(symbol.line)}${symbol.side === "base" ? " (base)" : ""}`;
  return `${name} [${symbol.kind}] ${where}`;
}

async function callersCheck(
  dir: string,
  files: FileDiff[],
  mergeBase: string,
  headSha: string,
  options: { maxHits: number },
): Promise<CheckResult> {
  const inDiff = new Set(
    files.flatMap((f) => [f.oldPath, f.newPath]).filter((p) => p !== undefined),
  );
  const symbols = new Map<string, TouchedSymbol>();
  for (const file of files) {
    if (file.binary || isTestFile(file.path)) continue;
    if (file.newPath !== undefined && CODE_FILE.test(file.newPath) && file.added.length > 0) {
      const content = await git(dir, ["show", `${headSha}:${file.newPath}`]);
      for (const s of touchedSymbols(
        content,
        file.added.map((l) => l.line),
        file.newPath,
        "head",
      )) {
        symbols.set(
          `${s.className ?? ""}#${s.name}`,
          symbols.get(`${s.className ?? ""}#${s.name}`) ?? s,
        );
      }
    }
    if (file.oldPath !== undefined && CODE_FILE.test(file.oldPath) && file.removed.length > 0) {
      const content = await git(dir, ["show", `${mergeBase}:${file.oldPath}`]);
      for (const s of touchedSymbols(
        content,
        file.removed.map((l) => l.line),
        file.oldPath,
        "base",
      )) {
        const key = `${s.className ?? ""}#${s.name}`;
        if (!symbols.has(key)) symbols.set(key, s);
      }
    }
  }
  if (symbols.size === 0) {
    return {
      id: "callers",
      title: "Callers outside the diff",
      status: "pass",
      summary: "the diff touches no exported or class-member declarations",
      details: [],
    };
  }

  const ordered = [...symbols.values()].toSorted(
    (a, b) =>
      Number(a.kind === "type") - Number(b.kind === "type") ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  const details: string[] = [];
  let withCallers = 0;
  const quiet: string[] = [];
  const references: Record<string, CallerHit[]> = {};
  const outside = async (name: string): Promise<CallerHit[]> =>
    // Comment-only lines mention a name without calling it.
    (await findReferences(dir, headSha, name)).filter(
      (hit) => !inDiff.has(hit.file) && !/^(?:\/\/|\/\*|\*)/.test(hit.text),
    );
  const classReach = new Map<string, number>();
  for (const symbol of ordered) {
    if (symbol.className !== undefined) {
      // A member is reached through its class. If nothing outside the diff names
      // the class, a word search for the member only finds unrelated same-named ones.
      let count = classReach.get(symbol.className);
      if (count === undefined) {
        count = (await outside(symbol.className)).length;
        classReach.set(symbol.className, count);
      }
      if (count === 0) {
        quiet.push(`${symbol.className}.${symbol.name}`);
        continue;
      }
    }
    if (GENERIC_NAMES.has(symbol.name) || symbol.name.length < 3) {
      details.push(
        `${symbolLabel(symbol)}: name too generic to search; review its callers by hand`,
      );
      continue;
    }
    // A removed symbol's callers live on the head; the head is what must still work.
    const hits = await outside(symbol.name);
    references[
      symbol.className === undefined ? symbol.name : `${symbol.className}.${symbol.name}`
    ] = hits;
    if (hits.length === 0) {
      quiet.push(
        symbol.className === undefined ? symbol.name : `${symbol.className}.${symbol.name}`,
      );
      continue;
    }
    withCallers++;
    const code = hits.filter((hit) => !isTestFile(hit.file));
    const tests = hits.filter((hit) => isTestFile(hit.file));
    const limit = symbol.kind === "type" ? Math.min(5, options.maxHits) : options.maxHits;
    details.push(
      `${symbolLabel(symbol)}: ${String(code.length)} references in ${String(new Set(code.map((h) => h.file)).size)} files` +
        (tests.length > 0 ? `, ${String(tests.length)} in tests` : ""),
    );
    for (const hit of code.slice(0, limit)) {
      details.push(`    ${hit.file}:${String(hit.line)}: ${truncate(hit.text)}`);
    }
    if (code.length > limit)
      details.push(`    … ${String(code.length - limit)} more (use --json for all)`);
    if (tests.length > 0) {
      details.push(`    tests: ${[...new Set(tests.map((h) => h.file))].slice(0, 5).join(", ")}`);
    }
  }
  if (quiet.length > 0) details.push(`no references outside the diff: ${quiet.join(", ")}`);
  return {
    id: "callers",
    title: "Callers outside the diff",
    status: withCallers > 0 ? "warn" : "pass",
    summary:
      withCallers > 0
        ? `${String(withCallers)} of ${String(symbols.size)} touched symbols are referenced outside the diff; review each caller`
        : `${String(symbols.size)} touched symbols, none referenced outside the diff`,
    details,
    data: { references },
  };
}

// ---------------------------------------------------------------------------
// Revert check (negative control)
// ---------------------------------------------------------------------------

export interface TestRunResult {
  code: number;
  output: string;
}

export type TestRunner = (cwd: string, tests: string[]) => Promise<TestRunResult>;

/** `pnpm exec vitest run <tests>` in `cwd`, output captured. */
export const vitestRunner: TestRunner = (cwd, tests) =>
  new Promise((resolve, reject) => {
    const quoted = tests.map((t) => `"${t.replace(/"/g, '\\"')}"`);
    const child = spawn("pnpm", ["exec", "vitest", "run", ...quoted], {
      cwd,
      shell: true,
      windowsHide: true,
      env: childEnv(),
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });

interface SavedFile {
  file: string;
  abs: string;
  bytes: Buffer | undefined;
  hash: string | undefined;
}

export const sha256 = (bytes: Buffer): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

function nearestPackageDir(checkout: string, file: string): string {
  let dir = path.dirname(path.resolve(checkout, file));
  const root = path.resolve(checkout);
  while (dir.startsWith(root)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return root;
}

const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function tail(output: string, lines = 25): string[] {
  return output
    .replace(ANSI_COLOUR, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .map((line) => `    ${truncate(line, 200)}`);
}

const MISSING_IMPORT =
  /does not provide an export named|is not exported by|Cannot find module|Failed to (?:resolve|load) (?:import|url)|is not a function|is not a constructor/;

export interface RevertOptions {
  tests: string[];
  projectDir?: string;
  /** Paths to revert; default every non-test file in the diff. */
  revert?: string[];
  runner: TestRunner;
  onProgress?: (message: string) => void;
}

function revertResult(status: CheckStatus, summary: string, details: string[] = []): CheckResult {
  return { id: "revert", title: "Revert check (negative control)", status, summary, details };
}

async function revertCheck(
  dir: string,
  files: FileDiff[],
  mergeBase: string,
  options: RevertOptions,
): Promise<CheckResult> {
  const nonTest = [
    ...new Set(files.filter((f) => !isTestFile(f.path)).flatMap((f) => [f.oldPath, f.newPath])),
  ].filter((p): p is string => p !== undefined);
  const toRevert = options.revert?.map((p) => p.replace(/\\/g, "/")) ?? nonTest;
  if (toRevert.length === 0) return revertResult("skip", "the diff changes only tests");

  const tests =
    options.tests.length > 0
      ? options.tests.map((t) => path.relative(dir, path.resolve(dir, t)).replace(/\\/g, "/"))
      : files
          .filter((f) => f.newPath !== undefined && isTestFile(f.newPath))
          .map((f) => f.newPath ?? "");
  if (tests.length === 0) {
    return revertResult(
      "fail",
      "no test files in the diff and none given with --test; nothing shows the fix is needed",
    );
  }
  const dirty = (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty !== "") {
    return revertResult(
      "fail",
      "refused: the checkout has uncommitted changes; commit or stash them first",
      dirty.split("\n"),
    );
  }
  for (const file of toRevert) {
    if (!fs.existsSync(path.join(dir, file))) continue;
    if (!(await gitOk(dir, ["ls-files", "--error-unmatch", "--", file]))) {
      return revertResult("fail", `refused: ${file} exists but is untracked; move it away first`);
    }
  }

  const groups = new Map<string, string[]>();
  for (const test of tests) {
    const cwd =
      options.projectDir !== undefined
        ? path.resolve(dir, options.projectDir)
        : nearestPackageDir(dir, test);
    const relative = path.relative(cwd, path.resolve(dir, test)).replace(/\\/g, "/");
    groups.set(cwd, [...(groups.get(cwd) ?? []), relative]);
  }
  const runAll = async (
    label: string,
  ): Promise<{ passed: boolean; details: string[]; output: string }> => {
    const details: string[] = [];
    let passed = true;
    let output = "";
    for (const [cwd, group] of groups) {
      const where = path.relative(dir, cwd) || ".";
      options.onProgress?.(`[pr-preflight] ${label}: vitest run ${group.join(" ")} (in ${where})`);
      const run = await options.runner(cwd, group);
      output += run.output;
      details.push(`${label}: exit ${String(run.code)} in ${where}: ${group.join(" ")}`);
      if (run.code !== 0) {
        passed = false;
        details.push(...tail(run.output));
      }
    }
    return { passed, details, output };
  };

  const branch = await runAll("branch");
  if (!branch.passed) {
    return revertResult("fail", "the tests fail on the branch itself", branch.details);
  }

  // Save the branch's exact working-tree bytes before touching anything.
  const saved: SavedFile[] = toRevert.map((file) => {
    const abs = path.join(dir, file);
    const bytes = fs.existsSync(abs) ? fs.readFileSync(abs) : undefined;
    return { file, abs, bytes, hash: bytes === undefined ? undefined : sha256(bytes) };
  });
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-preflight-"));
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
  const createdDirs: string[] = [];
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    for (const entry of saved) {
      if (entry.bytes === undefined) fs.rmSync(entry.abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(entry.abs), { recursive: true });
        fs.writeFileSync(entry.abs, entry.bytes);
      }
    }
    for (const created of createdDirs.toReversed()) {
      try {
        fs.rmdirSync(created);
      } catch {
        // not empty: something else lives there now
      }
    }
    restored = true;
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    restore();
    process.stderr.write(`[pr-preflight] ${signal}: branch files restored\n`);
    process.exit(130);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  signals.forEach((s) => process.once(s, onSignal));

  let reverted: Awaited<ReturnType<typeof runAll>>;
  try {
    for (const entry of saved) {
      if (await gitOk(dir, ["cat-file", "-e", `${mergeBase}:${entry.file}`])) {
        // --filters applies the checkout's line-ending and smudge rules.
        const bytes = await gitBuffer(dir, ["cat-file", "--filters", `${mergeBase}:${entry.file}`]);
        let parent = path.dirname(entry.abs);
        const missing: string[] = [];
        while (!fs.existsSync(parent)) {
          missing.push(parent);
          parent = path.dirname(parent);
        }
        createdDirs.push(...missing.toReversed());
        fs.mkdirSync(path.dirname(entry.abs), { recursive: true });
        fs.writeFileSync(entry.abs, bytes);
      } else {
        fs.rmSync(entry.abs, { force: true });
        // A directory the branch added would still resolve as a module; remove it
        // while empty. `restore` recreates it from the saved file's path.
        let parent = path.dirname(entry.abs);
        while (parent.startsWith(dir + path.sep) && fs.readdirSync(parent).length === 0) {
          fs.rmdirSync(parent);
          parent = path.dirname(parent);
        }
      }
    }
    reverted = await runAll("reverted");
  } finally {
    restore();
    signals.forEach((s) => process.removeListener(s, onSignal));
  }

  const mismatched = saved.filter((entry) => {
    const exists = fs.existsSync(entry.abs);
    if (entry.bytes === undefined) return exists;
    return !exists || sha256(fs.readFileSync(entry.abs)) !== entry.hash;
  });
  const after = (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (mismatched.length > 0 || after !== "") {
    return revertResult(
      "fail",
      `RESTORE FAILED: the branch files are not back as they were. A backup is in ${backup}`,
      [
        ...mismatched.map((m) => `differs: ${m.file}`),
        ...after.split("\n").filter((l) => l !== ""),
      ],
    );
  }
  fs.rmSync(backup, { recursive: true, force: true });

  const restoredNote = `restored ${String(saved.length)} files byte-identically; git status clean`;
  const details = [
    `reverted to ${mergeBase.slice(0, 7)}: ${toRevert.join(", ")}`,
    ...branch.details,
    ...reverted.details,
    restoredNote,
  ];
  if (reverted.passed) {
    return revertResult(
      "fail",
      "the tests still pass with the fix reverted; they do not prove the fix",
      details,
    );
  }
  if (MISSING_IMPORT.test(reverted.output)) {
    return revertResult(
      "warn",
      "the tests fail with the fix reverted, but apparently because something they import is missing. " +
        "Check they also fail with only the wiring reverted (--revert <file>)",
      details,
    );
  }
  return revertResult(
    "pass",
    "the tests pass on the branch and fail with the fix reverted",
    details,
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  checkout: string;
  base?: string;
  /** Compare against this ref without checking it out. Disables the revert check. */
  head?: string;
  tests?: string[];
  projectDir?: string;
  revert?: string[];
  skipRevert?: boolean;
  pr?: string;
  repo?: string;
  maxHits?: number;
  runner?: TestRunner;
  fetchPullRequest?: (pr: string, repo: string) => Promise<PullRequestText>;
  onProgress?: (message: string) => void;
  /** Lease owner for the checkout lock (default VORTEX_AI_OWNER or "anonymous"). */
  owner?: string;
  /** Lease directory override, for tests. */
  leaseDir?: string;
}

export async function fetchPullRequestText(pr: string, repo: string): Promise<PullRequestText> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "view", pr, "--repo", repo, "--json", "title,body,headRefOid,url"],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as PullRequestText;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const dir = path.resolve(options.checkout);
  if (!(await gitOk(dir, ["rev-parse", "--git-dir"]))) {
    throw new PreflightError(`${dir} is not a git checkout. Pass --checkout <dir>.`);
  }
  const base = options.base ?? "upstream/master";
  const head = options.head ?? "HEAD";
  const headSha = await resolveCommit(dir, head);
  const baseSha = await resolveCommit(dir, base);
  const mergeBase = (await git(dir, ["merge-base", baseSha, headSha])).trim();
  const notes: string[] = [];

  const diff = await git(dir, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-M",
    "--unified=0",
    mergeBase,
    headSha,
  ]);
  const files = parseUnifiedDiff(diff);
  if (options.head === undefined) {
    const dirty = (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).trim();
    if (dirty !== "")
      notes.push("uncommitted changes are not included; the checks read committed HEAD");
  }

  const checks: CheckResult[] = [sizeCheck(files)];
  checks.push(
    await callersCheck(dir, files, mergeBase, headSha, { maxHits: options.maxHits ?? 15 }),
  );

  if (options.skipRevert === true) {
    checks.push({
      id: "revert",
      title: "Revert check (negative control)",
      status: "skip",
      summary: "skipped (--skip-revert)",
      details: [],
    });
  } else if (options.head !== undefined) {
    checks.push({
      id: "revert",
      title: "Revert check (negative control)",
      status: "skip",
      summary:
        "not possible with --head: it compares refs without a checkout. Check the branch out and " +
        "run without --head",
      details: [],
    });
  } else {
    // The revert check rewrites the checkout, so it holds the checkout's lease: another
    // owner patching the same tree (vortex-e2e, another preflight) must not interleave.
    const owner = resolveOwner(options.owner);
    try {
      checks.push(
        await withLeases(
          [checkoutResource(dir)],
          owner,
          { purpose: "pr-preflight revert check", dir: options.leaseDir },
          () =>
            revertCheck(dir, files, mergeBase, {
              tests: options.tests ?? [],
              projectDir: options.projectDir,
              revert: options.revert,
              runner: options.runner ?? vitestRunner,
              onProgress: options.onProgress,
            }),
        ),
      );
    } catch (err) {
      if (!(err instanceof LeaseHeldError)) throw err;
      checks.push(
        revertResult("fail", "refused: another owner holds this checkout", [err.message]),
      );
    }
  }

  checks.push(commentCheck(files));

  if (options.pr !== undefined) {
    const fetch = options.fetchPullRequest ?? fetchPullRequestText;
    try {
      checks.push(lintPullRequest(await fetch(options.pr, options.repo ?? UPSTREAM), headSha));
    } catch (err) {
      checks.push({
        id: "description",
        title: "PR description",
        status: "fail",
        summary: `could not read PR ${options.pr}: ${(err as Error).message.split("\n")[0] ?? ""}`,
        details: [],
      });
    }
  } else {
    checks.push({
      id: "description",
      title: "PR description",
      status: "skip",
      summary: "no --pr given",
      details: [],
    });
  }

  return {
    checkout: dir,
    base,
    head,
    headSha,
    mergeBase,
    notes,
    checks,
    passed: checks.every((check) => check.status !== "fail"),
  };
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines = [
    `pr-preflight ${report.checkout}`,
    `base ${report.base} (merge-base ${report.mergeBase.slice(0, 7)}), head ${report.head} (${report.headSha.slice(0, 7)})`,
    ...report.notes.map((note) => `note: ${note}`),
    "",
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.title}: ${check.summary}`);
    for (const detail of check.details) lines.push(`  ${detail}`);
  }
  const count = (status: CheckStatus): number =>
    report.checks.filter((c) => c.status === status).length;
  lines.push(
    "",
    `Result: ${report.passed ? "no failures" : "FAILED"} (${String(count("fail"))} fail, ` +
      `${String(count("warn"))} warn, ${String(count("skip"))} skipped). ` +
      "Warnings are a to-review list; say in the PR how each was resolved.",
  );
  return lines.join("\n");
}
