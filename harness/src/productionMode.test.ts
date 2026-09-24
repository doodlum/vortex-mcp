import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bundleModeFromText,
  bundleModeOf,
  productionErrorMessage,
  productionProblem,
} from "./productionMode";

describe("productionProblem", () => {
  it("accepts only production NODE_ENV with React's production build loaded", () => {
    expect(
      productionProblem({
        nodeEnv: "production",
        react: { build: "production", files: ["react/cjs/react.production.min.js"] },
      }),
    ).toBeUndefined();
  });

  it("rejects what QA saw: NODE_ENV unset and React's development build", () => {
    const problem = productionProblem({
      nodeEnv: null,
      react: {
        build: "development",
        files: ["react-dom/cjs/react-dom.development.js", "react/cjs/react.development.js"],
      },
    });
    expect(problem).toContain(`NODE_ENV is null`);
    expect(problem).toContain("react.development.js");
    expect(productionErrorMessage(problem!)).toMatch(/--production was requested/);
  });

  it("rejects production NODE_ENV when React still loaded its development build", () => {
    expect(
      productionProblem({ nodeEnv: "production", react: { build: "development", files: [] } }),
    ).toBe("React's development build is loaded");
  });

  it("rejects an unknown React build and an extension too old to report one", () => {
    expect(productionProblem({ nodeEnv: "production", react: { build: "unknown" } })).toContain(
      "unknown build",
    );
    expect(productionProblem({ nodeEnv: "production" })).toContain("predates");
  });
});

describe("bundleModeOf", () => {
  it("recognises a development bundle by its unfolded NODE_ENV comparisons", () => {
    expect(bundleModeFromText(`const debugMissingIcons = "development" === "development";`)).toBe(
      "development",
    );
    expect(bundleModeFromText(`if ("development"!=="development")x()`)).toBe("development");
    expect(bundleModeFromText(`!function(){var e=1}();`)).toBe("production");
    expect(bundleModeFromText("")).toBe("unknown");
  });

  it("reads the checkout's renderer bundle, and is unknown without one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-bundle-test-"));
    try {
      expect(bundleModeOf(dir)).toBe("unknown");
      fs.mkdirSync(path.join(dir, "src", "main", "build"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "src", "main", "build", "renderer.js"),
        `const x = "development" === "development";`,
      );
      expect(bundleModeOf(dir)).toBe("development");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
