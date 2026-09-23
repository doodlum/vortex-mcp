import { describe, expect, it } from "vitest";

import { ForkError, parsePnpmVersion, selectPnpmCommand } from "./source";

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
