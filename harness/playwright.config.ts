import path from "node:path";

import { defineConfig } from "@playwright/test";

/**
 * A separate Playwright project from packages/e2e, because the two answer
 * different questions.
 *
 * packages/e2e is the deterministic CI suite: isolated temp profiles, a fake
 * game, no network. These tests instead exercise the AI automation stack itself
 * — the vortex-mcp extension's UI tools, the snapshot/act loop, window resizing
 * and hot reload — against a real Vortex build. They are slower, they need the
 * extension built, and they are run deliberately rather than on every push.
 */
export default defineConfig({
  testDir: "./src/tests",
  // Holds the machine-wide instance lease for the whole run.
  globalSetup: "./src/tests/leaseGlobalSetup.ts",
  // One at a time: the tools under test resize the real window and the MCP
  // server binds a fixed port, neither of which survives parallel workers.
  workers: 1,
  fullyParallel: false,
  // A cold bootstrap plus an Electron launch is minutes, not seconds.
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30_000 },
  reporter: [
    ["list"],
    [
      "html",
      { open: "never", outputFolder: path.resolve(import.meta.dirname, "playwright-report") },
    ],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "off",
    video: "off",
  },
});
