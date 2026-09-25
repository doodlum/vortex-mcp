import { describe, expect, it } from "vitest";

import { parseArgs } from "./cliArgs";

describe("parseArgs", () => {
  it("drops the separator pnpm forwards before the command", () => {
    expect(parseArgs(["--", "lease", "status"])).toMatchObject({
      command: "lease",
      positional: ["status"],
    });
  });

  it("takes script's --owner and --wait before or after the file, and passes the rest on", () => {
    const before = parseArgs(["script", "--owner", "qa", "probe.mts", "label", "--mode", "x"]);
    const after = parseArgs(["script", "probe.mts", "label", "--owner", "qa", "--mode", "x"]);
    for (const parsed of [before, after]) {
      expect(parsed.positional).toEqual(["probe.mts"]);
      expect(parsed.flags.owner).toBe("qa");
      expect(parsed.passthrough).toEqual(["label", "--mode", "x"]);
    }
    const inline = parseArgs(["script", "probe.mts", "--wait=5", "--owner=qa", "a"]);
    expect(inline.flags).toMatchObject({ wait: "5", owner: "qa" });
    expect(inline.passthrough).toEqual(["a"]);
  });

  it("gives the script everything after a bare --, its own --owner included", () => {
    const parsed = parseArgs(["script", "probe.mts", "--owner", "qa", "--", "--owner", "theirs"]);
    expect(parsed.flags.owner).toBe("qa");
    expect(parsed.passthrough).toEqual(["--owner", "theirs"]);
  });

  it("refuses a kit flag with no value after a script's path", () => {
    expect(() => parseArgs(["script", "probe.mts", "--owner"])).toThrow(/--owner needs a value/);
  });

  it("starts lease run's command at its first word", () => {
    const parsed = parseArgs(["lease", "run", "--owner", "qa", "pnpm", "run", "verify", "--x"]);
    expect(parsed.flags.owner).toBe("qa");
    expect(parsed.passthrough).toEqual(["pnpm", "run", "verify", "--x"]);
  });

  it("reads --checkout-only as a switch and repeats list flags", () => {
    const parsed = parseArgs([
      "lease",
      "acquire",
      "--checkout",
      "C:/dev/vx",
      "--checkout-only",
      "--owner",
      "qa",
    ]);
    expect(parsed.flags).toMatchObject({ checkout: "C:/dev/vx", "checkout-only": true });
    expect(parseArgs(["pr-preflight", "--test", "a", "--test", "b"]).lists.test).toEqual([
      "a",
      "b",
    ]);
  });
});
