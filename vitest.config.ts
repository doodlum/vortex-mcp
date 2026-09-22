import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // See src/test/vortex-api.stub.ts — real resolution is intercepted by
      // Vortex at runtime; tests always override this via vi.mock(...).
      "@nexusmods/vortex-api": path.resolve(import.meta.dirname, "src/test/vortex-api.stub.ts"),
    },
  },
  test: {
    environment: "node",
    // harness/**/*.spec.ts are Playwright e2e and deliberately not matched.
    include: ["src/**/*.test.ts", "harness/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
