import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { captureLogin, liveDir, loginDir, readMarker, snapshotDir } from "./bootstrap";
import type { HarnessConfig } from "./config";
import { requireOAuth } from "./auth";
import { stopStaleInstance } from "./instance";

vi.mock("./auth", () => ({
  requireOAuth: vi.fn(async () => ({ oauthPresent: true, oauthRefreshable: true })),
}));

// captureLogin stops the running instance before copying, because Vortex only
// flushes state on a clean close. Nothing is running in a unit test, so the
// stop is stubbed out; what is under test is what ends up in the snapshot.
vi.mock("./instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instance")>()),
  stopStaleInstance: vi.fn(async () => false),
}));

const roots: string[] = [];

function fakeConfig(): HarnessConfig {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-ai-bootstrap-"));
  roots.push(cacheDir);
  const config = {
    cacheDir,
    gameId: "fallout4",
    gamePath: "C:/Games/Fallout 4",
    apiKey: "test-key",
    target: { kind: "installed", appName: "Vortex", executable: "C:/Vortex/Vortex.exe" },
  } as unknown as HarnessConfig;
  fs.mkdirSync(liveDir(config), { recursive: true });
  fs.writeFileSync(
    path.join(liveDir(config), ".vortex-ai-snapshot.json"),
    JSON.stringify({ snapshotKey: path.basename(snapshotDir(config, "test-key")) }),
  );
  return config;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("captureLogin", () => {
  it("promotes the working directory and records that a login was captured", async () => {
    const config = fakeConfig();
    const live = liveDir(config);
    fs.mkdirSync(path.join(live, "userData"), { recursive: true });
    // Stands in for whatever Vortex wrote — the point is that it is copied
    // wholesale, never read, so the credential stays opaque to this code.
    fs.writeFileSync(path.join(live, "userData", "state.db"), "opaque-bytes");

    await captureLogin(config);

    const snapshot = snapshotDir(config, "test-key");
    expect(fs.readFileSync(path.join(snapshot, "userData", "state.db"), "utf8")).toBe(
      "opaque-bytes",
    );
    expect(readMarker(snapshot)?.loginCaptured).toBe(true);
    expect(readMarker(loginDir(config))?.loginCaptured).toBe(true);
  });

  it("replaces an earlier snapshot rather than merging into it", async () => {
    // A merge would leave files from the pre-login snapshot behind, which is
    // how a "captured" login ends up half-applied and failing much later.
    const config = fakeConfig();
    const snapshot = snapshotDir(config, "test-key");
    fs.mkdirSync(path.join(snapshot, "userData"), { recursive: true });
    fs.writeFileSync(path.join(snapshot, "userData", "stale.txt"), "from the old snapshot");

    const live = liveDir(config);
    fs.mkdirSync(path.join(live, "userData"), { recursive: true });
    fs.writeFileSync(path.join(live, "userData", "fresh.txt"), "signed in");

    await captureLogin(config);

    expect(fs.existsSync(path.join(snapshot, "userData", "fresh.txt"))).toBe(true);
    expect(fs.existsSync(path.join(snapshot, "userData", "stale.txt"))).toBe(false);
  });

  it("refuses when there is no working directory to capture", async () => {
    await expect(captureLogin(fakeConfig())).rejects.toThrow(/no working directory/i);
  });

  it("does not stop or copy an unsigned profile", async () => {
    const config = fakeConfig();
    fs.mkdirSync(path.join(liveDir(config), "userData"));
    vi.mocked(requireOAuth).mockRejectedValueOnce(new Error("OAuth setup incomplete"));
    await expect(captureLogin(config)).rejects.toThrow("OAuth setup incomplete");
    expect(stopStaleInstance).not.toHaveBeenCalled();
    expect(fs.existsSync(loginDir(config))).toBe(false);
  });

  it("preserves the previous login when clean shutdown fails", async () => {
    const config = fakeConfig();
    fs.mkdirSync(path.join(liveDir(config), "userData"));
    fs.mkdirSync(loginDir(config));
    fs.writeFileSync(path.join(loginDir(config), "sentinel"), "previous login");
    vi.mocked(stopStaleInstance).mockRejectedValueOnce(new Error("did not exit cleanly"));
    await expect(captureLogin(config)).rejects.toThrow("did not exit cleanly");
    expect(fs.readFileSync(path.join(loginDir(config), "sentinel"), "utf8")).toBe("previous login");
  });
});
