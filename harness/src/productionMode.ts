/**
 * `--production`: run a source build of Vortex the way a release runs, and prove it did.
 *
 * Vortex's bundler inlines `process.env.NODE_ENV` at build time (rolldown `define` for main,
 * webpack for the renderer). A plain `pnpm run build` has no NODE_ENV, so it produces a
 * development bundle: main.cjs's "set NODE_ENV=production unless development" becomes
 * `if (false)`, and renderer.tsx's "set process.env.NODE_ENV to production" branch is dead
 * code too. Removing NODE_ENV from the launch environment then leaves the renderer with none
 * at all, and React, which is required at run time rather than bundled, loads
 * `react.development.js`. Nothing errors; rendering is just several times slower. A bundle
 * built with NODE_ENV=production sets it itself, which is why the same kit gave production
 * React on one build of a checkout and development React on the next.
 *
 * So the harness sets NODE_ENV=production itself, then asks the renderer which React build
 * it loaded (`automation_status.react`) and refuses the run unless it is production.
 */
import fs from "node:fs";
import path from "node:path";

import { ConfigError } from "./config";

export interface ProductionStatus {
  nodeEnv?: string | null;
  react?: { build?: string; files?: string[] };
}

/** A ConfigError, so the CLI prints the message rather than a stack. */
export class ProductionModeError extends ConfigError {}

/** Why a renderer is not in production mode, or undefined when it is. */
export function productionProblem(status: ProductionStatus): string | undefined {
  const problems: string[] = [];
  if (status.nodeEnv !== "production") {
    problems.push(`the renderer's NODE_ENV is ${JSON.stringify(status.nodeEnv ?? null)}`);
  }
  const build = status.react?.build;
  if (build === undefined) {
    problems.push(
      "automation_status does not report which React build loaded (the extension predates it)",
    );
  } else if (build !== "production") {
    const files = status.react?.files ?? [];
    problems.push(
      `React's ${build} build is loaded` + (files.length > 0 ? ` (${files.join(", ")})` : ""),
    );
  }
  return problems.length === 0 ? undefined : problems.join("; ");
}

export function productionErrorMessage(problem: string): string {
  return (
    `--production was requested, but ${problem}. Timings from this instance would be ` +
    `development React's, so it was stopped.\n\n` +
    `  The harness launches with NODE_ENV=production; something overrode it (NODE_OPTIONS, a ` +
    `preload, or a checkout whose main process forces development).\n` +
    `  Check: pnpm run ai -- call automation_status   (nodeEnv, react.build)`
  );
}

export type BundleMode = "development" | "production" | "unknown";

/**
 * Whether a Vortex checkout's renderer bundle was built for development.
 *
 * webpack in development mode leaves inlined comparisons such as
 * `"development" === "development"` in the output; a production build folds and minifies
 * them away. With no marker the mode is reported as production only when the bundle
 * exists; otherwise unknown.
 */
export function bundleModeOf(sourceDir: string): BundleMode {
  const file = path.join(sourceDir, "src", "main", "build", "renderer.js");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "unknown";
  }
  return bundleModeFromText(text);
}

export function bundleModeFromText(text: string): BundleMode {
  if (/"development"\s*[!=]==?\s*"development"/.test(text)) return "development";
  return text.length > 0 ? "production" : "unknown";
}

export function devBundleWarning(sourceDir: string): string {
  return (
    `${sourceDir} was built without NODE_ENV=production (a development bundle). React runs ` +
    `its production build, but Vortex's own development-only branches, inlined at build ` +
    `time, still run (main-process file logging, renderer source-map support and process ` +
    `warning traces, missing-icon checks). For release parity rebuild with ` +
    `NODE_ENV=production: in PowerShell, $env:NODE_ENV='production'; pnpm run build; ` +
    `Remove-Item Env:NODE_ENV (nx caches the two modes separately).`
  );
}
