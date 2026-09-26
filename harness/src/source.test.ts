import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ForkError, parsePnpmVersion, selectPnpmCommand, runStreaming } from "./source";

it("preserves source paths containing spaces when invoking git", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex source "));
  try {
    await runStreaming("git", ["init", "--bare", path.join(dir, "source repo")], {
      label: "Initialize source fixture",
    });
    expect(fs.existsSync(path.join(dir, "source repo", "HEAD"))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Vortex source package manager", () => {
  it("reads the exact version while ignoring a Corepack integrity suffix", () => {
    expect(parsePnpmVersion("pnpm@11.10.0+sha512.deadbeef")).toBe("11.10.0");
    expect(parsePnpmVersion("pnpm@11.10.0")).toBe("11.10.0");
  });

  it("rejects an absent or floating package-manager declaration", () => {
    expect(() => parsePnpmVersion(undefined)).toThrow(ForkError);
    expect(() => parsePnpmVersion("pnpm@latest")).toThrow("exact pnpm version");
  });

  it("uses pnpm directly only when its version matches the source checkout", () => {
    expect(selectPnpmCommand("11.10.0", "11.10.0")).toEqual({
      cmd: "pnpm",
      args: [],
      version: "11.10.0",
      exact: true,
    });
  });

  it("bootstraps the checkout's exact version when PATH has another pnpm", () => {
    expect(selectPnpmCommand("11.10.0", "9.15.0")).toEqual({
      cmd: "pnpm",
      args: ["dlx", "pnpm@11.10.0"],
      version: "11.10.0",
      exact: false,
    });
  });
});
