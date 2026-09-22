/**
 * Finding the operator's Vortex fork on GitHub, and keeping a clone of it here.
 *
 * The suite has to work for someone who just cloned this repo, so it cannot
 * assume a Vortex checkout exists anywhere on the machine, and it must not go
 * hunting around the filesystem for one. Instead it asks GitHub who the operator
 * is, looks for their fork, and clones it **inside this repo** at
 * `.vortex-src/` (gitignored).
 *
 * Everything here works unauthenticated. `gh` is used when it happens to be
 * logged in, but the fallback — GitHub's public REST API plus the identity git
 * already knows — needs no token, which matters because requiring `gh auth
 * login` before you can build anything would be a poor first five minutes.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { REPO_ROOT } from "./config";

const execFileAsync = promisify(execFile);

export const UPSTREAM = "Nexus-Mods/Vortex";
const UPSTREAM_URL = `https://github.com/${UPSTREAM}.git`;

/** Where the Vortex clone lives — inside this repo, never outside it. */
export function vortexSourceDir(): string {
  return process.env.VORTEX_AI_SOURCE_DIR ?? path.join(REPO_ROOT, ".vortex-src");
}

export function hasVortexSource(dir = vortexSourceDir()): boolean {
  return fs.existsSync(path.join(dir, "src", "main", "package.json"));
}

export class ForkError extends Error {}

/**
 * Run a command, and on failure throw an error that actually says what happened.
 *
 * execFile's rejection carries only "Command failed: <cmd>"; the output that
 * explains why is on the error object's stdout/stderr and is otherwise lost.
 * For a step like `pnpm install`, which can fail for a dozen unrelated reasons,
 * that is the difference between a fixable message and a shrug.
 */
async function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; label: string },
): Promise<void> {
  try {
    await execFileAsync(cmd, args, {
      cwd: options.cwd,
      shell: true,
      maxBuffer: 100 * 1024 * 1024,
      timeout: options.timeoutMs ?? 60 * 60 * 1000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? ""].join("\n").trim();
    const tail = output.split(/\r?\n/).slice(-25).join("\n");
    throw new ForkError(
      `${options.label} failed (${cmd} ${args.join(" ")})` +
        (tail === "" ? `: ${e.message ?? "no output"}` : `:\n\n${tail}`),
    );
  }
}

async function tryExec(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { shell: true, timeout: 20_000 });
    const out = stdout.trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Work out the operator's GitHub login, cheapest signal first.
 *
 * The noreply-email parse is the quiet hero: GitHub hands out
 * `<id>+<login>@users.noreply.github.com`, and most people have it configured
 * already, so identity is usually known without `gh` being installed at all.
 */
export async function detectGitHubUser(): Promise<string | undefined> {
  const explicit = process.env.VORTEX_AI_GITHUB_USER;
  if (explicit !== undefined && explicit !== "") return explicit;

  const gh = await tryExec("gh", ["api", "user", "--jq", ".login"]);
  if (gh !== undefined) return gh;

  const configured = await tryExec("git", ["config", "--get", "github.user"]);
  if (configured !== undefined) return configured;

  const email = await tryExec("git", ["config", "--get", "user.email"]);
  const noreply = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email ?? "");
  if (noreply?.[1] !== undefined) return noreply[1];

  return tryExec("git", ["config", "--get", "user.name"]);
}

export interface ForkInfo {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isFork: boolean;
  parent: string | undefined;
}

/** Look up `<user>/Vortex` on GitHub. Undefined when it does not exist. */
export async function findFork(user: string): Promise<ForkInfo | undefined> {
  const response = await fetch(`https://api.github.com/repos/${user}/Vortex`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return undefined;
  if (response.status === 403) {
    throw new ForkError(
      "GitHub rate-limited the unauthenticated lookup of your fork. Either wait a few minutes, " +
        "run `gh auth login`, or set VORTEX_AI_GITHUB_USER and VORTEX_AI_VORTEX_REPO to skip " +
        "discovery entirely.",
    );
  }
  if (!response.ok) {
    throw new ForkError(`GitHub returned ${String(response.status)} looking up ${user}/Vortex.`);
  }

  const repo = (await response.json()) as {
    full_name: string;
    clone_url: string;
    default_branch: string;
    fork: boolean;
    parent?: { full_name: string };
  };
  return {
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
    isFork: repo.fork,
    parent: repo.parent?.full_name,
  };
}

/**
 * Resolve which repository to clone.
 *
 * A fork rather than upstream on purpose: the point of this suite is to build,
 * change and push Vortex, and you cannot push to Nexus-Mods/Vortex. Failing with
 * "go and fork it" is more useful than silently cloning a repo the operator
 * cannot commit to.
 */
export async function resolveVortexRepo(): Promise<ForkInfo> {
  const override = process.env.VORTEX_AI_VORTEX_REPO;
  if (override !== undefined && override !== "") {
    const asUrl = override.includes("://") || override.endsWith(".git");
    return {
      fullName: asUrl ? override : override,
      cloneUrl: asUrl ? override : `https://github.com/${override}.git`,
      defaultBranch: "master",
      isFork: true,
      parent: undefined,
    };
  }

  const user = await detectGitHubUser();
  if (user === undefined) {
    throw new ForkError(
      "Could not work out your GitHub username, so I cannot find your Vortex fork.\n\n" +
        "  Set it explicitly:   VORTEX_AI_GITHUB_USER=<your-login>\n" +
        "  Or point at a repo:  VORTEX_AI_VORTEX_REPO=<owner>/<repo>\n" +
        "  Or log in:           gh auth login",
    );
  }

  const fork = await findFork(user);
  if (fork === undefined) {
    throw new ForkError(
      `No Vortex fork found at https://github.com/${user}/Vortex.\n\n` +
        `  This suite builds and tests YOUR fork, so you need one:\n\n` +
        `    gh repo fork ${UPSTREAM} --clone=false\n` +
        `  or fork it in the browser: https://github.com/${UPSTREAM}/fork\n\n` +
        `  Then re-run. If your fork is named something else, set\n` +
        `  VORTEX_AI_VORTEX_REPO=${user}/<name>. If "${user}" is the wrong login,\n` +
        `  set VORTEX_AI_GITHUB_USER.`,
    );
  }

  if (!fork.isFork) {
    // Not fatal — someone may keep a non-fork mirror — but worth saying, because
    // the usual cause is a typo'd username that happens to own a repo named Vortex.
    process.stderr.write(
      `[vortex-ai] note: ${fork.fullName} is not a fork of ${UPSTREAM}; using it anyway.\n`,
    );
  }

  return fork;
}

export interface EnsureSourceOptions {
  /** Re-fetch and fast-forward an existing clone. */
  update?: boolean;
  /** Progress reporting. */
  onProgress?: (message: string) => void;
}

export interface VortexSource {
  dir: string;
  repo: string;
  defaultBranch: string;
  cloned: boolean;
}

/**
 * Ensure a Vortex clone exists at `.vortex-src`, cloning it if not.
 *
 * `upstream` is wired up alongside `origin` so the usual "sync my fork" flow
 * works without further setup — the fork is where changes are pushed, upstream
 * is where they are rebased from.
 */
export async function ensureVortexSource(options: EnsureSourceOptions = {}): Promise<VortexSource> {
  const report = options.onProgress ?? ((): void => undefined);
  const dir = vortexSourceDir();

  if (hasVortexSource(dir)) {
    const remote = (await tryExec("git", ["-C", dir, "remote", "get-url", "origin"])) ?? "unknown";
    const branch =
      (await tryExec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])) ?? "master";
    if (options.update === true) {
      report("fetching origin and upstream");
      await tryExec("git", ["-C", dir, "fetch", "--all", "--prune"]);
    }
    return { dir, repo: remote, defaultBranch: branch, cloned: false };
  }

  const fork = await resolveVortexRepo();
  report(`cloning ${fork.fullName} into ${dir} (this is a large repo — several minutes)`);

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A full Vortex clone over a slow link genuinely takes a while; a short
  // timeout here would abort a working clone and leave a half-written dir.
  await run("git", ["clone", fork.cloneUrl, dir], {
    label: `Cloning ${fork.fullName}`,
    timeoutMs: 30 * 60 * 1000,
  });

  await tryExec("git", ["-C", dir, "remote", "add", "upstream", UPSTREAM_URL]);
  report(`cloned; origin=${fork.fullName}, upstream=${UPSTREAM}`);

  return { dir, repo: fork.fullName, defaultBranch: fork.defaultBranch, cloned: true };
}

/**
 * Install dependencies and build the clone.
 *
 * Kept separate from cloning because it is by far the slower half and the one
 * most likely to need re-running on its own after a pull.
 */
export async function buildVortexSource(options: EnsureSourceOptions = {}): Promise<void> {
  const report = options.onProgress ?? ((): void => undefined);
  const dir = vortexSourceDir();
  if (!hasVortexSource(dir)) {
    throw new ForkError(`No Vortex clone at ${dir}. Run \`vortex-ai source\` first.`);
  }

  report("installing dependencies (slow: native modules are rebuilt)");
  await run("pnpm", ["install"], { cwd: dir, label: "Installing Vortex's dependencies" });

  report("building renderer and main");
  try {
    await run("pnpm", ["nx", "run", "@vortex/main:build"], { cwd: dir, label: "Building Vortex" });
  } catch (err) {
    // Vortex's full build can exit non-zero on a bundled extension whose native
    // dependency did not build, while still having produced the renderer and
    // most other outputs. Fall back to building main's own bundle so one
    // unrelated extension cannot block the whole suite — but only accept that
    // if the artifacts the harness actually needs exist afterwards.
    report("full build failed; building main's own bundle directly");
    await run("node", ["./build.mjs"], {
      cwd: path.join(dir, "src", "main"),
      label: "Building main",
      timeoutMs: 30 * 60 * 1000,
    });
    if (!buildArtifactsPresent(dir)) throw err;
    report("main built — the earlier failure was in a bundled extension");
  }

  report("build complete");
}

/** The outputs the harness needs in order to launch a source build. */
export function buildArtifactsPresent(dir = vortexSourceDir()): boolean {
  const build = path.join(dir, "src", "main", "build");
  return (
    fs.existsSync(path.join(build, "main.cjs")) && fs.existsSync(path.join(build, "renderer.js"))
  );
}
