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
  id: "size" | "callers" | "state" | "dispatch" | "revert" | "comments" | "description";
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
// Hunks, for reverting part of a file
// ---------------------------------------------------------------------------

export interface Hunk {
  /** 1-based first line on each side; for an empty side, the line before the change. */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  removed: string[];
  added: string[];
}

/** Hunks of a single file's `git diff -U0`. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        removed: [],
        added: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === undefined || line.startsWith("\\")) continue;
    if (line.startsWith("-") && !line.startsWith("--- ")) current.removed.push(line.slice(1));
    else if (line.startsWith("+") && !line.startsWith("+++ ")) current.added.push(line.slice(1));
  }
  return hunks;
}

/**
 * The hunk covering a head-side (1-based) line. A pure deletion has no head lines, so it is
 * named by the line before or after it, when no other hunk holds that line.
 */
export function hunkAt(hunks: Hunk[], line: number): Hunk | undefined {
  return (
    hunks.find((h) => h.newCount > 0 && line >= h.newStart && line < h.newStart + h.newCount) ??
    hunks.find((h) => h.newCount === 0 && (line === h.newStart || line === h.newStart + 1))
  );
}

/** The head file's text with the given hunks undone, keeping its line endings. */
export function revertHunksIn(head: string, hunks: Hunk[]): string {
  const eol = head.includes("\r\n") ? "\r\n" : "\n";
  const lines = head.split(/\r?\n/);
  for (const hunk of hunks.toSorted((a, b) => b.newStart - a.newStart)) {
    const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    lines.splice(at, hunk.newCount, ...hunk.removed);
  }
  return lines.join(eol);
}

/** `--revert-hunk <file>:<line>`: a checkout-relative path and a head-side line. */
export function parseHunkSpec(spec: string): { file: string; line: number } {
  const match = /^(.+):(\d+)$/.exec(spec.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new PreflightError(
      `--revert-hunk ${spec}: expected <file>:<line>, a head-side line inside the hunk.`,
    );
  }
  return { file: match[1].replace(/\\/g, "/"), line: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// Classification and size
// ---------------------------------------------------------------------------

/**
 * Test code: `*.test.*`/`*.spec.*`, and anything under `__tests__`, `__mocks__`, `__fixtures__`
 * or a `test-utils` directory (Vortex's `src/renderer/src/test-utils/` harnesses and builders,
 * an extension's own `test-utils/`), which only tests import.
 */
const TEST_FILE =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|test-utils)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

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
  /**
   * The private (unexported) function the diff actually changed, when this symbol is listed
   * because it calls that function: its callers are the ones that notice.
   */
  via?: string;
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

type LineParser = (index: number) => ParsedLine;

function memoParser(source: string[]): LineParser {
  const parsed = new Map<number, ParsedLine>();
  return (index) => {
    let value = parsed.get(index);
    if (value === undefined) {
      value = parseLine(source[index] ?? "");
      parsed.set(index, value);
    }
    return value;
  };
}

/** The declarations enclosing a (0-based) line, innermost first; empty for a blank line. */
function enclosingChain(
  source: string[],
  parse: LineParser,
  start: number,
): { index: number; parsed: ParsedLine }[] {
  const text = source[start];
  if (text === undefined || text.trim() === "") return [];
  const chain: { index: number; parsed: ParsedLine }[] = [];
  const own = parse(start);
  let threshold = own.indent;
  if (own.decl !== undefined || own.memberName !== undefined) {
    chain.push({ index: start, parsed: own });
  }
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
  return chain;
}

/**
 * The unexported top-level functions and constants (not classes or types) enclosing the given
 * (1-based) lines: private helpers such as `testRef` in testModReference.ts, whose changes
 * reach callers only through the exported functions that call them.
 */
export function privateTouched(content: string, lines: number[]): string[] {
  const source = content.split(/\r?\n/);
  const parse = memoParser(source);
  const names = new Set<string>();
  for (const lineNumber of lines) {
    const chain = enclosingChain(source, parse, lineNumber - 1);
    const top = chain.find((element) => element.parsed.indent === 0);
    if (top === undefined || top.parsed.isClass) continue;
    // Inside a class member it is the member that is reported (touchedSymbols).
    const inClass = chain.some((element, i) => {
      const parent = chain[i + 1];
      return parent?.parsed.isClass === true && element !== top;
    });
    const decl = top.parsed.decl;
    if (inClass || decl === undefined || decl.kind === "type" || decl.kind === "class") continue;
    if (decl.exported || exportedByName(content, decl.name)) continue;
    names.add(decl.name);
  }
  return [...names];
}

/**
 * One level up from changed private helpers: the exported functions and class members in the
 * same file that call them, each marked `via` the helper. A caller that is itself private is
 * not followed further.
 */
export function symbolsViaPrivate(
  content: string,
  names: string[],
  file: string,
  side: "head" | "base",
): TouchedSymbol[] {
  const source = content.split(/\r?\n/);
  const out = new Map<string, TouchedSymbol>();
  for (const name of names) {
    const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
    const uses: number[] = [];
    source.forEach((line, i) => {
      if (!word.test(line) || /^\s*(?:\/\/|\/\*|\*)/.test(line)) return;
      if (parseLine(line).decl?.name === name) return;
      uses.push(i + 1);
    });
    for (const symbol of touchedSymbols(content, uses, file, side)) {
      const key = `${symbol.className ?? ""}#${symbol.name}`;
      if (!out.has(key)) out.set(key, { ...symbol, via: name });
    }
  }
  return [...out.values()];
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
  const parse = memoParser(source);
  const found = new Map<string, TouchedSymbol>();

  for (const lineNumber of lines) {
    const chain = enclosingChain(source, parse, lineNumber - 1);

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

// ---------------------------------------------------------------------------
// Member uses, module consumers and state readers
// ---------------------------------------------------------------------------

const escapeRegExp = (value: string): string => value.replace(/[$.*+?^(){}|[\]\\]/g, "\\$&");

/**
 * How a line uses `name` as a class member: through member access (`x.name`, `this.name`,
 * `x?.name`, but not a `...name` spread) or as a JSX attribute (`name={…}`, in .jsx/.tsx).
 * Undefined for a bare identifier, which is a local or an import of something else.
 */
export function memberUse(text: string, name: string, file = ""): "member" | "jsx" | undefined {
  const n = escapeRegExp(name);
  if (new RegExp(`(?<!\\.)\\.${n}(?![\\w$])`).test(text)) return "member";
  if (/\.[jt]sx$/.test(file) && new RegExp(`(?:^|[\\s{(<])${n}=[{"'\`]`).test(text)) return "jsx";
  return undefined;
}

/** Whether the line declares its own class member called `name` (not a call or a local). */
export function declaresOwnMember(text: string, name: string): boolean {
  const n = escapeRegExp(name);
  return new RegExp(
    // Leading whitespace is optional: `git grep` hits arrive trimmed.
    `^\\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\\s+)*` +
      `${n}\\s*[?!]?\\s*(?::[^=;]+)?(?:=(?!=)|\\([^)]*\\)\\s*(?::[^{;]+)?\\{)`,
  ).test(text);
}

export interface FilteredHits {
  kept: CallerHit[];
  dropped: number;
}

/**
 * Keep only the hits that can reach a class member called `name`: member access and JSX
 * attributes. A file that declares its own member of that name is another class's; its
 * declaration and its `this.name` uses are dropped too.
 */
export function filterMemberHits(
  hits: CallerHit[],
  name: string,
  options: { jsx?: boolean } = {},
): FilteredHits {
  const own = new Set(hits.filter((h) => declaresOwnMember(h.text, name)).map((h) => h.file));
  const self = new RegExp(`\\bthis\\.${escapeRegExp(name)}(?![\\w$])`, "g");
  // A getter or field is only ever read as `x.name`; a JSX attribute of that name is a prop.
  const counts = (text: string, file: string): boolean => {
    const use = memberUse(text, name, file);
    return use === "member" || (use === "jsx" && options.jsx !== false);
  };
  const kept = hits.filter((hit) => {
    if (!own.has(hit.file)) return counts(hit.text, hit.file);
    if (declaresOwnMember(hit.text, name)) return false;
    return counts(hit.text.replace(self, ""), hit.file);
  });
  return { kept, dropped: hits.length - kept.length };
}

/** Whether the file's default export is, or wraps, `name` (`export default connect(…)(Name)`). */
export function defaultExportMentions(content: string, name: string): boolean {
  const n = escapeRegExp(name);
  if (
    new RegExp(`^export\\s+default\\s+(?:abstract\\s+)?(?:class|function)\\s+${n}\\b`, "m").test(
      content,
    )
  )
    return true;
  if (new RegExp(`export\\s*\\{[^}]*\\b${n}\\s+as\\s+default\\b`).test(content)) return true;
  const at = content.search(/^export\s+default\b/m);
  if (at === -1) return false;
  const rest = content.slice(at, at + 2_000);
  const end = rest.search(/;\s*$/m);
  return new RegExp(`\\b${n}\\b`).test(end === -1 ? rest : rest.slice(0, end + 1));
}

export interface ImportBinding {
  spec: string;
  defaultName?: string;
  namespace?: string;
  /** Named bindings as `imported` → `local`; for a re-export, `local` is the exported name. */
  named: { imported: string; local: string }[];
  typeOnly: boolean;
  reexport: boolean;
}

function namedList(raw: string | undefined): ImportBinding["named"] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((part) =>
      part
        .replace(/\/\/.*$/gm, "")
        .replace(/^\s*type\s+/, "")
        .trim(),
    )
    .filter((part) => part !== "")
    .map((part) => {
      const [imported = part, local = imported] = part.split(/\s+as\s+/).map((s) => s.trim());
      return { imported, local };
    });
}

/** The static imports and re-exports of a module, from a regex over its source. */
export function parseImports(content: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const imports =
    /\bimport\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:\*\s*as\s+([\w$]+)\s*)?from\s*["']([^"']+)["']/g;
  for (const m of content.matchAll(imports)) {
    const defaultName = m[2] === "type" ? undefined : m[2];
    out.push({
      spec: m[5] ?? "",
      defaultName,
      namespace: m[4],
      named: namedList(m[3]),
      typeOnly: m[1] !== undefined,
      reexport: false,
    });
  }
  for (const m of content.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    out.push({
      spec: m[3] ?? "",
      named: namedList(m[2]),
      typeOnly: m[1] !== undefined,
      reexport: true,
    });
  }
  return out;
}

const withoutExtension = (file: string): string =>
  file.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]sx?|mts|cts)$/, "");

/**
 * Whether `spec`, imported from `importer`, names the module `target`. Relative specs are
 * resolved; `@/x` and `~/x` aliases match any target path ending in `/x`.
 */
export function importTargets(importer: string, spec: string, target: string): boolean {
  const goal = withoutExtension(target);
  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    candidates.push(
      withoutExtension(path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec))),
    );
    return candidates.some((c) => c === goal || `${c}/index` === goal);
  }
  const alias = /^[@~]\/(.+)$/.exec(spec)?.[1];
  if (alias === undefined) return false;
  const aliased = withoutExtension(alias);
  return goal.endsWith(`/${aliased}`) || goal.endsWith(`/${aliased}/index`);
}

/** Names a barrel exports `local` under: `export { local }`, `export { local as X }`. */
export function exportedNames(content: string, local: string): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(/\bexport\s*(?:default\s*)?\{([^}]*)\}(?!\s*from)/g)) {
    for (const binding of namedList(m[1])) {
      if (binding.imported === local) names.add(binding.local);
    }
  }
  return [...names];
}

/** Fields of `this` a line assigns: `this.x = …`, `this.x += …`, `this.x++`, `--this.x`. */
export function assignedFields(text: string): string[] {
  const found = new Set<string>();
  const assign = /\bthis\.([A-Za-z_$#][\w$]*)\s*(?:[-+*/%&|^]|\*\*|\?\?|\|\||&&|<<|>>>?)?=(?!=)/g;
  for (const m of text.matchAll(assign)) if (m[1] !== undefined) found.add(m[1]);
  for (const m of text.matchAll(/\bthis\.([A-Za-z_$#][\w$]*)\s*(?:\+\+|--)/g))
    if (m[1] !== undefined) found.add(m[1]);
  for (const m of text.matchAll(/(?:\+\+|--)\s*this\.([A-Za-z_$#][\w$]*)/g))
    if (m[1] !== undefined) found.add(m[1]);
  return [...found];
}

/** 1-based lines of `content` that read `this.<field>` other than to assign it. */
export function stateReaders(content: string, field: string): number[] {
  const f = escapeRegExp(field);
  const write = new RegExp(
    `\\bthis\\.${f}\\s*(?:(?:[-+*/%&|^]|\\*\\*|\\?\\?|\\|\\||&&|<<|>>>?)?=(?!=)|\\+\\+|--)|(?:\\+\\+|--)\\s*this\\.${f}(?![\\w$])`,
    "g",
  );
  const read = new RegExp(`\\bthis\\.${f}(?![\\w$])`);
  const lines: number[] = [];
  content.split(/\r?\n/).forEach((text, i) => {
    if (/^\s*(?:\/\/|\/\*|\*)/.test(text)) return;
    if (read.test(text.replace(write, ""))) lines.push(i + 1);
  });
  return lines;
}

const GETTER = (name: string): RegExp =>
  new RegExp(
    `^\\s+(?:(?:public|protected|static|override)\\s+)*get\\s+${escapeRegExp(name)}\\s*\\(`,
  );

/** The head-side lines each file's diff adds (with --unified=0, exactly its hunks). */
export function changedLines(files: FileDiff[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.newPath === undefined) continue;
    out.set(file.newPath, new Set(file.added.map((l) => l.line)));
  }
  return out;
}

/**
 * Hits of a touched symbol that are callers: not its own declaration, and, for a class
 * member, member uses. In the member's own file `this.name` counts (it is that class's);
 * elsewhere a file declaring a same-named member is another class's (filterMemberHits).
 */
export function callerHits(symbol: TouchedSymbol, hits: CallerHit[]): FilteredHits {
  const own = (hit: CallerHit): boolean => hit.file === symbol.file;
  const declaration = (hit: CallerHit): boolean =>
    own(hit) && symbol.side === "head" && hit.line === symbol.line;
  const candidates = hits.filter((hit) => !declaration(hit));
  if (symbol.className === undefined) {
    return { kept: candidates, dropped: hits.length - candidates.length };
  }
  const inFile = candidates.filter(
    (hit) =>
      own(hit) &&
      memberUse(hit.text, symbol.name, hit.file) !== undefined &&
      !declaresOwnMember(hit.text, symbol.name),
  );
  const elsewhere = filterMemberHits(
    candidates.filter((hit) => !own(hit)),
    symbol.name,
  ).kept;
  const kept = [...inFile, ...elsewhere].toSorted(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
  return { kept, dropped: hits.length - kept.length };
}

function symbolLabel(symbol: TouchedSymbol): string {
  const name = symbol.className === undefined ? symbol.name : `${symbol.className}.${symbol.name}`;
  const where = `${symbol.file}:${String(symbol.line)}${symbol.side === "base" ? " (base)" : ""}`;
  const via = symbol.via === undefined ? "" : ` via private ${symbol.via}`;
  return `${name} [${symbol.kind}]${via} ${where}`;
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
      const lines = file.added.map((l) => l.line);
      for (const s of [
        ...touchedSymbols(content, lines, file.newPath, "head"),
        ...symbolsViaPrivate(content, privateTouched(content, lines), file.newPath, "head"),
      ]) {
        symbols.set(
          `${s.className ?? ""}#${s.name}`,
          symbols.get(`${s.className ?? ""}#${s.name}`) ?? s,
        );
      }
    }
    if (file.oldPath !== undefined && CODE_FILE.test(file.oldPath) && file.removed.length > 0) {
      const content = await git(dir, ["show", `${mergeBase}:${file.oldPath}`]);
      const lines = file.removed.map((l) => l.line);
      for (const s of [
        ...touchedSymbols(content, lines, file.oldPath, "base"),
        ...symbolsViaPrivate(content, privateTouched(content, lines), file.oldPath, "base"),
      ]) {
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
  const repo = new RepoReader(dir, headSha, inDiff, changedLines(files));
  const listHits = (label: string, hits: CallerHit[], limit: number, note = ""): void => {
    const code = hits.filter((hit) => !isTestFile(hit.file));
    const tests = hits.filter((hit) => isTestFile(hit.file));
    details.push(
      `${label}: ${String(code.length)} references in ${String(new Set(code.map((h) => h.file)).size)} files` +
        (tests.length > 0 ? `, ${String(tests.length)} in tests` : "") +
        note,
    );
    for (const hit of code.slice(0, limit)) {
      details.push(`    ${hit.file}:${String(hit.line)}: ${truncate(hit.text)}`);
    }
    if (code.length > limit)
      details.push(`    … ${String(code.length - limit)} more (use --json for all)`);
    if (tests.length > 0) {
      details.push(`    tests: ${[...new Set(tests.map((h) => h.file))].slice(0, 5).join(", ")}`);
    }
  };

  // The class or component a consumer outside the diff reaches: by its name, and, when it
  // is its file's default export, through every module importing that file and every
  // barrel (controls/api.ts, util/api.ts) re-exporting it. Each of them can notice a change
  // to any of its members.
  const reach = new Map<string, Consumers>();
  const consumersOf = async (name: string, file: string): Promise<Consumers> => {
    const key = `${file}#${name}`;
    let found = reach.get(key);
    if (found === undefined) {
      // The class's own file mentioning it (its declaration, `export default`) consumes nothing.
      const direct = (await repo.outside(name)).filter(
        (hit) => !isTestFile(hit.file) && hit.file !== file,
      );
      const content = await repo.read(file);
      const modules =
        content !== undefined && defaultExportMentions(content, name)
          ? await moduleConsumers(repo, file)
          : undefined;
      found = { name, file, direct, modules };
      reach.set(key, found);
    }
    return found;
  };
  const enclosing = new Map<string, { consumers: Consumers; members: string[] }>();

  for (const symbol of ordered) {
    const label =
      symbol.className === undefined ? symbol.name : `${symbol.className}.${symbol.name}`;
    // Set for a member of a class nothing outside the diff reaches: only its own file's
    // uses (`this.name` outside the hunks) can be its callers.
    let ownFileOnly = false;
    if (symbol.className !== undefined) {
      // A member is reached through its class. If nothing outside the diff reaches the
      // class, a search for the member only finds unrelated same-named ones.
      const consumers = await consumersOf(symbol.className, symbol.file);
      const entry = enclosing.get(consumers.file + consumers.name) ?? { consumers, members: [] };
      entry.members.push(symbol.name);
      enclosing.set(consumers.file + consumers.name, entry);
      if (consumerCount(consumers) === 0) ownFileOnly = true;
    } else if (symbol.kind !== "type" && symbol.side === "head") {
      const consumers = await consumersOf(symbol.name, symbol.file);
      if (consumers.modules !== undefined) {
        const entry = enclosing.get(consumers.file + consumers.name) ?? {
          consumers,
          members: [],
        };
        enclosing.set(consumers.file + consumers.name, entry);
      }
    }
    if (GENERIC_NAMES.has(symbol.name) || symbol.name.length < 3) {
      if (ownFileOnly) {
        quiet.push(label);
        continue;
      }
      details.push(
        `${symbolLabel(symbol)}: name too generic to search; review its callers by hand`,
      );
      continue;
    }
    // A removed symbol's callers live on the head; the head is what must still work.
    // Members are reached as `x.name`, `this.name` or a JSX attribute, never as a bare
    // word: those are locals, imports and same-named members of other classes.
    const filtered = callerHits(symbol, await repo.outside(symbol.name));
    const hits = ownFileOnly
      ? filtered.kept.filter((hit) => hit.file === symbol.file)
      : filtered.kept;
    const declarations = filtered.dropped;
    let note = "";
    if (symbol.className !== undefined && declarations > 0) {
      note = ` (${String(declarations)} bare-name, other-class or declaration hits left out)`;
    }
    const inChanged = hits.filter((hit) => inDiff.has(hit.file) && !isTestFile(hit.file));
    if (inChanged.length > 0) {
      note += `; ${String(inChanged.length)} in changed files, outside their hunks`;
    }
    references[label] = hits;
    if (hits.length === 0) {
      quiet.push(label);
      continue;
    }
    withCallers++;
    listHits(
      symbolLabel(symbol),
      hits,
      symbol.kind === "type" ? Math.min(5, options.maxHits) : options.maxHits,
      note,
    );
  }

  const consumerData: Record<string, unknown> = {};
  for (const { consumers, members } of enclosing.values()) {
    const count = consumerCount(consumers);
    consumerData[consumers.name] = consumers;
    if (count === 0) continue;
    withCallers++;
    const via = members.length > 0 ? `encloses the touched ${members.join(", ")}` : "touched";
    details.push(
      `consumers of ${consumers.name} (${consumers.file}, ${via}): every one can notice the change`,
    );
    details.push(
      `    by name: ${String(consumers.direct.length)} references in ` +
        `${String(new Set(consumers.direct.map((h) => h.file)).size)} files`,
    );
    const modules = consumers.modules;
    if (modules !== undefined) {
      const importers = modules.importers.filter((i) => !isTestFile(i.file));
      details.push(
        `    default export imported by ${String(importers.length)} files: ` +
          truncate(importers.map((i) => `${i.file} (as ${i.local})`).join(", "), 600),
      );
      for (const re of modules.reexports) {
        const code = re.consumers.filter((f) => !isTestFile(f));
        details.push(
          `    re-exported as ${re.name} by ${re.barrel}; imported from there or vortex-api by ` +
            `${String(code.length)} files: ${truncate(code.join(", "), 600)}`,
        );
      }
    }
  }

  if (quiet.length > 0) details.push(`no references outside the diff: ${quiet.join(", ")}`);
  return {
    id: "callers",
    title: "Callers outside the diff",
    status: withCallers > 0 ? "warn" : "pass",
    summary:
      withCallers > 0
        ? `${String(withCallers)} entries reach the ${String(symbols.size)} touched symbols from outside the diff; review each caller`
        : `${String(symbols.size)} touched symbols, none referenced outside the diff`,
    details,
    data: { references, consumers: consumerData },
  };
}

interface Consumers {
  name: string;
  file: string;
  direct: CallerHit[];
  modules?: ModuleConsumers;
}

const consumerCount = (c: Consumers): number =>
  c.direct.length +
  (c.modules?.importers.length ?? 0) +
  (c.modules?.reexports.reduce((sum, r) => sum + r.consumers.length, 0) ?? 0);

export interface ModuleConsumers {
  /** Files outside the diff importing the module's default export, with the local name. */
  importers: { file: string; local: string }[];
  /** Barrels re-exporting it, and the files outside the diff importing it from them. */
  reexports: { barrel: string; name: string; consumers: string[] }[];
}

/** Reads a commit's files through git, cached, and searches them. */
class RepoReader {
  private contents = new Map<string, string | undefined>();

  /**
   * @param inDiff files the diff touches, left out of file-level searches (`files`)
   * @param changed head-side lines the diff adds, per file: word hits on them are the diff
   *   itself, while a caller elsewhere in a changed file is still a caller outside the diff
   */
  constructor(
    readonly dir: string,
    readonly commit: string,
    readonly inDiff: Set<string>,
    readonly changed: Map<string, Set<number>> = new Map(),
  ) {}

  async read(file: string): Promise<string | undefined> {
    if (!this.contents.has(file)) {
      this.contents.set(
        file,
        await git(this.dir, ["show", `${this.commit}:${file}`]).catch(() => undefined),
      );
    }
    return this.contents.get(file);
  }

  /**
   * Word hits outside the diff's hunks, comment-only lines left out. A file the diff
   * touches still counts: `referenceEqual` called at reducers/mods.ts:184 was missed while
   * whole changed files were skipped, because the PR changed other lines of that file.
   */
  async outside(name: string): Promise<CallerHit[]> {
    return (await findReferences(this.dir, this.commit, name)).filter(
      (hit) =>
        this.changed.get(hit.file)?.has(hit.line) !== true && !/^(?:\/\/|\/\*|\*)/.test(hit.text),
    );
  }

  /** Files outside the diff matching `git grep` arguments (`-e` patterns and flags). */
  async files(args: string[]): Promise<string[]> {
    let out: string;
    try {
      out = await git(this.dir, ["grep", "-l", "-I", ...args, this.commit, "--", ...CALLER_ROOTS]);
    } catch (err) {
      if ((err as { code?: number }).code === 1) return [];
      throw err;
    }
    const prefix = `${this.commit}:`;
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
      .filter((file) => !this.inDiff.has(file));
  }
}

/** Where a module's default export is imported, directly or through a re-exporting barrel. */
async function moduleConsumers(repo: RepoReader, file: string): Promise<ModuleConsumers> {
  const base = path.posix.basename(withoutExtension(file));
  const stem = base === "index" ? path.posix.basename(path.posix.dirname(file)) : base;
  const ere = stem.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&");
  const candidates = await repo.files(["-E", "-e", `["'][^"']*/${ere}(\\.[a-z]+)?["']`]);
  const result: ModuleConsumers = { importers: [], reexports: [] };
  const barrels: { barrel: string; name: string }[] = [];
  for (const candidate of candidates) {
    const content = await repo.read(candidate);
    if (content === undefined) continue;
    for (const binding of parseImports(content)) {
      if (binding.typeOnly || !importTargets(candidate, binding.spec, file)) continue;
      const locals = [
        ...(binding.reexport ? [] : [binding.defaultName]),
        ...binding.named.filter((n) => n.imported === "default").map((n) => n.local),
      ].filter((n): n is string => n !== undefined);
      for (const local of locals) {
        if (binding.reexport) {
          barrels.push({ barrel: candidate, name: local });
          continue;
        }
        result.importers.push({ file: candidate, local });
        for (const name of exportedNames(content, local)) {
          barrels.push({ barrel: candidate, name });
        }
      }
    }
  }
  if (barrels.length === 0) return result;
  // Only files that name an API module at all can import through one; reading just those
  // keeps this to a few git calls on a large tree.
  const apiImporters = new Set(await repo.files(["-F", "-e", "vortex-api", "-e", "/api"]));
  for (const { barrel, name } of barrels) {
    const namespace = path.posix.basename(path.posix.dirname(barrel));
    const named = (await repo.files(["-w", "-F", "-e", name])).filter((f) => apiImporters.has(f));
    // util/api.ts and friends are also reached as a namespace: `util.name(…)`.
    const namespaced =
      namespace === "controls" ? [] : await repo.files(["-F", "-e", `${namespace}.${name}`]);
    const consumers = new Set<string>(namespaced.filter((f) => f !== barrel));
    for (const candidate of named) {
      if (candidate === barrel || consumers.has(candidate)) continue;
      const content = await repo.read(candidate);
      if (content === undefined) continue;
      const fromBarrel = parseImports(content).some(
        (b) =>
          !b.typeOnly &&
          (/^(?:@nexusmods\/)?vortex-api$/.test(b.spec) ||
            importTargets(candidate, b.spec, barrel)) &&
          b.named.some((n) => n.imported === name),
      );
      if (fromBarrel) consumers.add(candidate);
    }
    result.reexports.push({ barrel, name, consumers: [...consumers].toSorted() });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dispatchers of actions whose reducer changed
// ---------------------------------------------------------------------------

/** A reducer handler key: `[actions.addModRule as any]: (state, payload) => …`. */
const REDUCER_KEY = /^(\s*)\[\s*(?:[\w$]+\.)?([A-Za-z_$][\w$]*)(?:\s+as\s+any)?\s*\]\s*:/;

export interface TouchedReducer {
  /** The action creator's name, as the reducer's key names it. */
  action: string;
  file: string;
  /** 1-based line of the handler's key. */
  line: number;
}

/**
 * The reducer handlers (`[actions.x as any]: (state, payload) => …` in an IReducerSpec's
 * `reducers`) enclosing each changed line, found by walking up to the nearest key line
 * indented less than the change, or the change itself.
 */
export function touchedReducers(
  content: string,
  changed: number[],
  file: string,
): TouchedReducer[] {
  const lines = content.split(/\r?\n/);
  const found = new Map<string, TouchedReducer>();
  for (const at of changed) {
    const start = lines[at - 1];
    if (start === undefined) continue;
    let indent = start.trim() === "" ? Number.POSITIVE_INFINITY : indentOf(start);
    for (let i = at; i >= 1; i--) {
      const text = lines[i - 1] ?? "";
      if (text.trim() === "") continue;
      const own = indentOf(text);
      const key = REDUCER_KEY.exec(text);
      if (key !== null && (i === at || own < indent)) {
        const action = key[2] ?? "";
        if (!found.has(action)) found.set(action, { action, file, line: i });
        break;
      }
      if (own < indent) {
        indent = own;
        // Left the handler map, or reached the top level: not inside a reducer.
        if (own === 0 || /\breducers\s*:\s*\{/.test(text)) break;
      }
    }
  }
  return [...found.values()];
}

export type DispatchUse = "definition" | "call" | "type";

/**
 * How a line refers to action creator `name`: its definition (`const name = createAction(`),
 * a call (`dispatch(name(…))`, `actions.name(…)`), or nothing worth listing (an import, a
 * reducer key, a bare mention).
 */
export function dispatchUse(text: string, name: string): DispatchUse | undefined {
  const n = escapeRegExp(name);
  if (new RegExp(`\\b(?:const|let|var|function)\\s+${n}\\b`).test(text)) return "definition";
  if (REDUCER_KEY.test(text) && new RegExp(`\\[\\s*(?:[\\w$]+\\.)?${n}\\b`).test(text))
    return undefined;
  if (new RegExp(`(?<![\\w$])(?:[\\w$]+\\.)?${n}\\s*\\(`).test(text)) return "call";
  return undefined;
}

/** The action type string a creator is defined with: `createAction("ADD_MOD_RULE", …)`. */
export function actionTypeOf(content: string, name: string): string | undefined {
  const n = escapeRegExp(name);
  const at = content.search(new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=`));
  if (at === -1) return undefined;
  const window = content.slice(at, at + 400);
  return /[cC]reate\w*Action\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/.exec(window)?.[1];
}

async function dispatchCheck(
  dir: string,
  files: FileDiff[],
  mergeBase: string,
  headSha: string,
  options: { maxHits: number },
): Promise<CheckResult> {
  const inDiff = new Set(
    files.flatMap((f) => [f.oldPath, f.newPath]).filter((p) => p !== undefined),
  );
  const repo = new RepoReader(dir, headSha, inDiff, changedLines(files));
  const reducers = new Map<string, TouchedReducer>();
  for (const file of files) {
    if (file.binary || isTestFile(file.path)) continue;
    if (file.newPath !== undefined && CODE_FILE.test(file.newPath) && file.added.length > 0) {
      const content = await repo.read(file.newPath);
      if (content !== undefined) {
        const touched = touchedReducers(
          content,
          file.added.map((l) => l.line),
          file.newPath,
        );
        for (const r of touched) if (!reducers.has(r.action)) reducers.set(r.action, r);
      }
    }
    if (file.oldPath !== undefined && CODE_FILE.test(file.oldPath) && file.removed.length > 0) {
      const content = await git(dir, ["show", `${mergeBase}:${file.oldPath}`]).catch(() => "");
      const touched = touchedReducers(
        content,
        file.removed.map((l) => l.line),
        file.oldPath,
      );
      for (const r of touched) if (!reducers.has(r.action)) reducers.set(r.action, r);
    }
  }
  if (reducers.size === 0) {
    return {
      id: "dispatch",
      title: "Dispatchers of changed reducers",
      status: "pass",
      summary: "the diff changes no reducer handler",
      details: [],
    };
  }

  const details: string[] = [];
  const data: Record<string, unknown> = {};
  let sites = 0;
  for (const reducer of reducers.values()) {
    const hits = await repo.outside(reducer.action);
    const definitions = hits.filter((h) => dispatchUse(h.text, reducer.action) === "definition");
    const calls = hits.filter((h) => dispatchUse(h.text, reducer.action) === "call");
    let type: string | undefined;
    for (const def of definitions) {
      const content = await repo.read(def.file);
      type ??= content === undefined ? undefined : actionTypeOf(content, reducer.action);
    }
    const byType =
      type === undefined
        ? []
        : (await repo.outside(type)).filter(
            (h) => !definitions.some((d) => d.file === h.file && Math.abs(d.line - h.line) <= 3),
          );
    const code = calls.filter((h) => !isTestFile(h.file));
    const tests = calls.filter((h) => isTestFile(h.file));
    sites += code.length + byType.filter((h) => !isTestFile(h.file)).length;
    data[reducer.action] = { reducer, type, definitions, calls, byType };
    const inExtensions = code.filter((h) => h.file.startsWith("extensions/")).length;
    details.push(
      `${reducer.action}${type === undefined ? "" : ` (${type})`}: reducer at ` +
        `${reducer.file}:${String(reducer.line)}; ${String(code.length)} dispatch sites in ` +
        `${String(new Set(code.map((h) => h.file)).size)} files` +
        (inExtensions > 0 ? `, ${String(inExtensions)} in extensions` : "") +
        (tests.length > 0 ? `, ${String(tests.length)} in tests` : ""),
    );
    for (const def of definitions) {
      details.push(`    created at ${def.file}:${String(def.line)}: ${truncate(def.text)}`);
    }
    for (const hit of code.slice(0, options.maxHits)) {
      details.push(`    ${hit.file}:${String(hit.line)}: ${truncate(hit.text)}`);
    }
    if (code.length > options.maxHits)
      details.push(`    … ${String(code.length - options.maxHits)} more (use --json for all)`);
    const typed = byType.filter((h) => !isTestFile(h.file));
    if (typed.length > 0) {
      details.push(`    by type string ${String(type)}: ${String(typed.length)} lines`);
      for (const hit of typed.slice(0, 5)) {
        details.push(`      ${hit.file}:${String(hit.line)}: ${truncate(hit.text)}`);
      }
    }
  }
  return {
    id: "dispatch",
    title: "Dispatchers of changed reducers",
    status: sites > 0 ? "warn" : "pass",
    summary:
      sites > 0
        ? `${String(reducers.size)} reducer handlers changed, dispatched from ${String(sites)} places outside the diff; check what each passes still reduces the same`
        : `${String(reducers.size)} reducer handlers changed, no dispatches found outside the diff`,
    details,
    data,
  };
}
// ---------------------------------------------------------------------------
// Readers of changed class state
// ---------------------------------------------------------------------------

/**
 * Class fields whose assignments the diff adds or removes (`this.mStep = …`), and every
 * other line of the head file that reads them, by enclosing member. A reader that is a
 * getter exposes the field, so its uses outside the diff are listed too.
 */
async function stateCheck(
  dir: string,
  files: FileDiff[],
  headSha: string,
  options: { maxHits: number },
): Promise<CheckResult> {
  const inDiff = new Set(
    files.flatMap((f) => [f.oldPath, f.newPath]).filter((p) => p !== undefined),
  );
  const repo = new RepoReader(dir, headSha, inDiff, changedLines(files));
  const details: string[] = [];
  const data: Record<string, unknown> = {};
  let fieldCount = 0;
  let readerCount = 0;
  for (const file of files) {
    if (file.binary || isTestFile(file.path) || file.newPath === undefined) continue;
    if (!CODE_FILE.test(file.newPath)) continue;
    const fields = new Set(
      [...file.added, ...file.removed].flatMap((line) => assignedFields(line.text)),
    );
    if (fields.size === 0) continue;
    const content = await repo.read(file.newPath);
    if (content === undefined) continue;
    const changed = new Set(file.added.map((l) => l.line));
    const lines = content.split(/\r?\n/);
    for (const field of fields) {
      fieldCount++;
      const readers = stateReaders(content, field).filter((line) => !changed.has(line));
      const byMember = new Map<string, { symbol?: TouchedSymbol; lines: number[] }>();
      for (const line of readers) {
        const [symbol] = touchedSymbols(content, [line], file.newPath, "head");
        const key =
          symbol === undefined
            ? "(top level)"
            : symbol.className === undefined
              ? `${symbol.name} (constructor or top level)`
              : `${symbol.className}.${symbol.name}`;
        const entry = byMember.get(key) ?? { symbol, lines: [] };
        entry.lines.push(line);
        byMember.set(key, entry);
      }
      data[`${file.newPath}#${field}`] = [...byMember.entries()].map(([member, e]) => ({
        member,
        lines: e.lines,
      }));
      if (byMember.size === 0) {
        details.push(`${file.newPath}: this.${field} is not read outside the changed lines`);
        continue;
      }
      readerCount += readers.length;
      details.push(
        `${file.newPath}: this.${field} is assigned by the diff and read by ${String(byMember.size)} members`,
      );
      for (const [member, entry] of byMember) {
        const where = entry.lines.slice(0, 6).map(String).join(", ");
        const first = lines[(entry.lines[0] ?? 1) - 1] ?? "";
        details.push(`    ${member} (line ${where}): ${truncate(first.trim(), 100)}`);
        const symbol = entry.symbol;
        if (symbol?.className === undefined) continue;
        if (!GETTER(symbol.name).test(lines[symbol.line - 1] ?? "")) continue;
        const uses = filterMemberHits(await repo.outside(symbol.name), symbol.name, {
          jsx: false,
        }).kept.filter((hit) => !isTestFile(hit.file));
        details.push(`      getter ${symbol.name}: ${String(uses.length)} uses outside the diff`);
        for (const hit of uses.slice(0, options.maxHits)) {
          details.push(`        ${hit.file}:${String(hit.line)}: ${truncate(hit.text)}`);
        }
        if (uses.length > options.maxHits)
          details.push(`        … ${String(uses.length - options.maxHits)} more`);
      }
    }
  }
  return {
    id: "state",
    title: "Readers of changed state",
    status: readerCount > 0 ? "warn" : "pass",
    summary:
      fieldCount === 0
        ? "the diff assigns no class fields"
        : readerCount > 0
          ? `${String(fieldCount)} class fields the diff assigns are read on ${String(readerCount)} other lines; check each reader still holds`
          : `${String(fieldCount)} class fields the diff assigns, not read elsewhere`,
    details,
    data,
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

/**
 * A `--test` path as a checkout-relative path. It may be absolute, relative to the
 * checkout root, or relative to `--project-dir` (where vitest runs, so the form vitest
 * itself prints); the first that exists wins. Nothing existing is an error, not a
 * silently empty test run.
 */
export function resolveTestPath(checkout: string, test: string, projectDir?: string): string {
  const root = path.resolve(checkout);
  const tried = path.isAbsolute(test)
    ? [path.resolve(test)]
    : [
        path.resolve(root, test),
        ...(projectDir === undefined ? [] : [path.resolve(root, projectDir, test)]),
      ];
  const found = tried.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new PreflightError(
      `--test ${test} does not exist; tried ${tried.join(" and ")}. Give it relative to the ` +
        "checkout root or to --project-dir.",
    );
  }
  const relative = path.relative(root, found);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PreflightError(`--test ${test} is outside the checkout ${root}.`);
  }
  return relative.replace(/\\/g, "/");
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
  /** Paths to revert; default every non-test file in the diff (none when `revertHunks`). */
  revert?: string[];
  /** Single hunks to revert, each named by a head-side line inside it. */
  revertHunks?: Array<{ file: string; line: number }>;
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
  const hunkSpecs = options.revertHunks ?? [];
  const whole =
    options.revert?.map((p) => p.replace(/\\/g, "/")) ?? (hunkSpecs.length > 0 ? [] : nonTest);
  // Files reverted hunk by hunk: their reverted text is computed from the diff.
  const partial = new Map<string, { specs: number[]; content?: Buffer }>();
  for (const spec of hunkSpecs) {
    if (whole.includes(spec.file)) {
      return revertResult("fail", `${spec.file} is given to both --revert and --revert-hunk`);
    }
    const entry = partial.get(spec.file) ?? { specs: [] };
    entry.specs.push(spec.line);
    partial.set(spec.file, entry);
  }
  const hunkNotes: string[] = [];
  for (const [file, entry] of partial) {
    const diff = await git(dir, ["diff", "--no-color", "-U0", mergeBase, "HEAD", "--", file]);
    const hunks = parseHunks(diff);
    const chosen: Hunk[] = [];
    for (const line of entry.specs) {
      const hunk = hunkAt(hunks, line);
      if (hunk === undefined) {
        return revertResult(
          "fail",
          `--revert-hunk ${file}:${String(line)}: no hunk of the diff covers that head line`,
          hunks.map((h) =>
            h.newCount === 0
              ? `hunk: deletion after head line ${String(h.newStart)}`
              : `hunk: head lines ${String(h.newStart)}-${String(h.newStart + h.newCount - 1)}`,
          ),
        );
      }
      if (!chosen.includes(hunk)) chosen.push(hunk);
    }
    const head = fs.readFileSync(path.join(dir, file), "utf8");
    entry.content = Buffer.from(revertHunksIn(head, chosen), "utf8");
    hunkNotes.push(
      `${file}: reverted ${String(chosen.length)} of ${String(hunks.length)} hunks (head lines ` +
        `${chosen.map((h) => `${String(h.newStart)}+${String(h.newCount)}`).join(", ")})`,
    );
  }
  const toRevert = [...whole, ...partial.keys()];
  if (toRevert.length === 0) return revertResult("skip", "the diff changes only tests");

  let tests: string[];
  try {
    tests =
      options.tests.length > 0
        ? options.tests.map((t) => resolveTestPath(dir, t, options.projectDir))
        : files
            .filter((f) => f.newPath !== undefined && isTestFile(f.newPath))
            .map((f) => f.newPath ?? "");
  } catch (err) {
    return revertResult("fail", (err as Error).message);
  }
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
      options.onProgress?.(
        `[pr-preflight] ${label}: vitest run ${group.join(" ")} (in ${where}; paths relative to it)`,
      );
      const run = await options.runner(cwd, group);
      output += run.output;
      details.push(
        `${label}: exit ${String(run.code)} in ${where} (paths relative to it): ${group.join(" ")}`,
      );
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
      const hunkContent = partial.get(entry.file)?.content;
      if (hunkContent !== undefined) {
        fs.writeFileSync(entry.abs, hunkContent);
      } else if (await gitOk(dir, ["cat-file", "-e", `${mergeBase}:${entry.file}`])) {
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
    ...(whole.length > 0 ? [`reverted to ${mergeBase.slice(0, 7)}: ${whole.join(", ")}`] : []),
    ...hunkNotes,
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
  /** `--revert-hunk <file>:<line>` specs (see parseHunkSpec). */
  revertHunks?: string[];
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
  checks.push(await stateCheck(dir, files, headSha, { maxHits: options.maxHits ?? 15 }));
  checks.push(
    await dispatchCheck(dir, files, mergeBase, headSha, { maxHits: options.maxHits ?? 15 }),
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
              revertHunks: (options.revertHunks ?? []).map(parseHunkSpec),
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
