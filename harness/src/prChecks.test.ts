import { describe, expect, it } from "vitest";

import {
  classifyJobFailure,
  formatPullRequestChecks,
  pullRequestChecksPassed,
  runIdFromUrl,
  type CheckJob,
  type PullRequestCheckReport,
} from "./prChecks";

const step = (name: string, conclusion: string) => ({
  name,
  conclusion,
  status: "completed",
});

describe("PR check diagnosis", () => {
  it("separates passed E2E tests from encrypted-report failures", () => {
    const job: CheckJob = {
      name: "e2e (vortex-e2e)",
      status: "completed",
      conclusion: "failure",
      steps: [
        step("Run E2E tests (Windows)", "success"),
        step("Verify the test run produced a report", "success"),
        step("Encrypt test report", "failure"),
        step("Upload test report", "failure"),
      ],
    };
    expect(classifyJobFailure(job)).toEqual({
      kind: "post-processing",
      failedSteps: ["Encrypt test report", "Upload test report"],
      testsPassed: true,
    });
  });

  it("reports a failing test step as a test failure", () => {
    const job: CheckJob = {
      name: "build (windows-latest)",
      status: "completed",
      conclusion: "failure",
      steps: [step("Build", "success"), step("Test", "failure")],
    };
    expect(classifyJobFailure(job)?.kind).toBe("tests");
  });

  it("formats actionable detail beneath the failed check", () => {
    const report: PullRequestCheckReport = {
      number: 24274,
      url: "https://github.com/Nexus-Mods/Vortex/pull/24274",
      head: "abc123",
      checks: [
        {
          name: "e2e (vortex-e2e)",
          workflow: "E2E Tests",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/Nexus-Mods/Vortex/actions/runs/123/job/456",
        },
      ],
      runs: [
        {
          id: "123",
          jobs: [
            {
              name: "e2e (vortex-e2e)",
              status: "completed",
              conclusion: "failure",
              steps: [
                step("Run E2E tests (Windows)", "success"),
                step("Encrypt test report", "failure"),
              ],
            },
          ],
        },
      ],
    };
    expect(formatPullRequestChecks(report)).toContain(
      "Tests passed; post-processing failed: Encrypt test report",
    );
    expect(pullRequestChecksPassed(report)).toBe(false);
    expect(runIdFromUrl(report.checks[0]?.detailsUrl)).toBe("123");
  });

  it("does not repeat sibling failures when a run contains multiple jobs", () => {
    const report: PullRequestCheckReport = {
      number: 2,
      url: "https://example.test/pr/2",
      head: "abc123",
      checks: [
        {
          name: "windows",
          workflow: "Main",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://example.test/actions/runs/22/job/1",
        },
      ],
      runs: [
        {
          id: "22",
          jobs: [
            {
              name: "windows",
              status: "completed",
              conclusion: "failure",
              steps: [step("Test", "failure")],
            },
            {
              name: "linux",
              status: "completed",
              conclusion: "failure",
              steps: [step("Build", "failure")],
            },
          ],
        },
      ],
    };
    expect(formatPullRequestChecks(report)).not.toContain("Build");
  });

  it("treats successful, skipped, and neutral completed checks as passing", () => {
    const report: PullRequestCheckReport = {
      number: 1,
      url: "https://example.test/pr/1",
      head: "def456",
      checks: ["SUCCESS", "SKIPPED", "NEUTRAL"].map((conclusion) => ({
        name: conclusion,
        workflow: "Main",
        status: "COMPLETED",
        conclusion,
      })),
      runs: [],
    };
    expect(pullRequestChecksPassed(report)).toBe(true);
  });
});
