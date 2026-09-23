import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { UPSTREAM } from "./source";

const execFileAsync = promisify(execFile);

export interface CheckStep {
  name: string;
  status: string;
  conclusion: string;
}

export interface CheckJob {
  name: string;
  status: string;
  conclusion: string;
  steps: CheckStep[];
}

export interface CheckRun {
  id: string;
  jobs: CheckJob[];
}

export interface PullRequestCheck {
  name: string;
  workflow: string;
  status: string;
  conclusion: string;
  detailsUrl?: string;
}

export interface PullRequestCheckReport {
  number: number;
  url: string;
  head: string;
  checks: PullRequestCheck[];
  runs: CheckRun[];
}

export type FailureKind = "tests" | "post-processing" | "setup-or-infrastructure";

export interface JobFailure {
  kind: FailureKind;
  failedSteps: string[];
  testsPassed: boolean;
}

const TEST_STEP = /^(?:run\s+)?(?:(?:unit|integration|e2e|renderer)\s+)?tests?(?:\s|$|\()/i;
const POST_PROCESSING_STEP =
  /(?:encrypt|upload).*(?:artifact|report|result)|(?:artifact|report|result).*(?:encrypt|upload)/i;

/** Distinguish a failed test from a failure that happened after tests completed. */
export function classifyJobFailure(job: CheckJob): JobFailure | undefined {
  const failed = job.steps.filter((step) => step.conclusion.toLowerCase() === "failure");
  if (failed.length === 0) return undefined;

  const testSteps = job.steps.filter((step) => TEST_STEP.test(step.name));
  const testsPassed = testSteps.some((step) => step.conclusion.toLowerCase() === "success");
  const failedSteps = failed.map((step) => step.name);
  if (failed.some((step) => TEST_STEP.test(step.name))) {
    return { kind: "tests", failedSteps, testsPassed: false };
  }
  if (testsPassed && failed.every((step) => POST_PROCESSING_STEP.test(step.name))) {
    return { kind: "post-processing", failedSteps, testsPassed: true };
  }
  return { kind: "setup-or-infrastructure", failedSteps, testsPassed };
}

export function runIdFromUrl(url: string | undefined): string | undefined {
  return /\/actions\/runs\/(\d+)/.exec(url ?? "")?.[1];
}

function symbol(check: PullRequestCheck): string {
  if (check.status.toLowerCase() !== "completed") return "…";
  if (["success", "neutral", "skipped"].includes(check.conclusion.toLowerCase())) return "✓";
  return "✗";
}

export function formatPullRequestChecks(report: PullRequestCheckReport): string {
  const lines = [`PR #${String(report.number)} — ${report.url}`, `Head: ${report.head}`];
  const jobsByRun = new Map(report.runs.map((run) => [run.id, run.jobs]));

  for (const check of report.checks) {
    const workflow = check.workflow === "" ? check.name : `${check.workflow} / ${check.name}`;
    lines.push(`${symbol(check)} ${workflow}: ${check.conclusion || check.status}`);
    if (check.conclusion.toLowerCase() !== "failure") continue;

    const runId = runIdFromUrl(check.detailsUrl);
    const runJobs = runId === undefined ? [] : (jobsByRun.get(runId) ?? []);
    const exactJobs = runJobs.filter((job) => job.name === check.name);
    const matchingJobs =
      exactJobs.length > 0
        ? exactJobs
        : runJobs.filter((job) => job.conclusion.toLowerCase() === "failure");
    for (const job of matchingJobs) {
      const failure = classifyJobFailure(job);
      if (failure === undefined) continue;
      if (failure.kind === "post-processing") {
        lines.push(`  Tests passed; post-processing failed: ${failure.failedSteps.join(", ")}`);
      } else {
        lines.push(`  ${failure.kind}: ${failure.failedSteps.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

async function ghJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("gh", args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

interface GhCheck {
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
}

/** Read the current PR head and expand failed checks into their exact failed steps. */
export async function inspectPullRequestChecks(
  ref: string,
  repo = UPSTREAM,
): Promise<PullRequestCheckReport> {
  const pr = await ghJson<{
    number: number;
    url: string;
    headRefOid: string;
    statusCheckRollup: GhCheck[];
  }>(["pr", "view", ref, "--repo", repo, "--json", "number,url,headRefOid,statusCheckRollup"]);
  const checks = pr.statusCheckRollup.map((check) => ({
    name: check.name ?? check.context ?? "unknown check",
    workflow: check.workflowName ?? "",
    status: check.status ?? "unknown",
    conclusion: check.conclusion ?? "",
    detailsUrl: check.detailsUrl,
  }));
  const failedRunIds = [
    ...new Set(
      checks
        .filter((check) => check.conclusion.toLowerCase() === "failure")
        .map((check) => runIdFromUrl(check.detailsUrl))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  const runs = await Promise.all(
    failedRunIds.map(async (id) => {
      const run = await ghJson<{ jobs: CheckJob[] }>([
        "run",
        "view",
        id,
        "--repo",
        repo,
        "--json",
        "jobs",
      ]);
      return { id, jobs: run.jobs };
    }),
  );
  return { number: pr.number, url: pr.url, head: pr.headRefOid, checks, runs };
}

export function pullRequestChecksPassed(report: PullRequestCheckReport): boolean {
  return report.checks.every(
    (check) =>
      check.status.toLowerCase() === "completed" &&
      ["success", "neutral", "skipped"].includes(check.conclusion.toLowerCase()),
  );
}
