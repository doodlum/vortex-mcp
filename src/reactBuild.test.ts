import { describe, expect, it } from "vitest";

import { loadedReactBuild, reactBuildFrom } from "./reactBuild";

const root = "C:\\dev\\vx\\node_modules\\.pnpm\\react@18.3.1\\node_modules\\";

describe("reactBuildFrom", () => {
  it("reports development when the renderer loaded React's development build", () => {
    // What QA saw under --production on a development bundle of Vortex.
    const result = reactBuildFrom([
      `${root}react\\cjs\\react.development.js`,
      `${root}react\\cjs\\react-jsx-runtime.development.js`,
      `${root}react-dom\\cjs\\react-dom.development.js`,
      `${root}react-dnd\\dist\\cjs\\index.js`,
    ]);
    expect(result.build).toBe("development");
    expect(result.files).toEqual([
      "react-dom/cjs/react-dom.development.js",
      "react/cjs/react.development.js",
    ]);
  });

  it("reports production only when both react and react-dom are production builds", () => {
    expect(
      reactBuildFrom([
        `${root}react\\cjs\\react.production.min.js`,
        `${root}react-dom\\cjs\\react-dom.production.min.js`,
      ]).build,
    ).toBe("production");
    // React 19 drops the .min suffix.
    expect(
      reactBuildFrom([
        "/x/node_modules/react/cjs/react.production.js",
        "/x/node_modules/react-dom/cjs/react-dom.production.js",
      ]).build,
    ).toBe("production");
    expect(reactBuildFrom([`${root}react\\cjs\\react.production.min.js`]).build).toBe("unknown");
  });

  it("treats any development file as development, even beside production ones", () => {
    expect(
      reactBuildFrom([
        `${root}react\\cjs\\react.production.min.js`,
        `${root}react-dom\\cjs\\react-dom.development.js`,
      ]).build,
    ).toBe("development");
  });

  it("is unknown when React is not in the module cache (bundled, or not loaded)", () => {
    expect(reactBuildFrom([`${root}react-dnd\\dist\\cjs\\index.js`])).toEqual({
      build: "unknown",
      files: [],
    });
  });

  it("reads this process's module cache without throwing", () => {
    expect(["production", "development", "unknown"]).toContain(loadedReactBuild().build);
  });
});
