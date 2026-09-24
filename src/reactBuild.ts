/**
 * Which React build the renderer actually loaded.
 *
 * `process.env.NODE_ENV` says what React *would* pick, but React chooses its build once,
 * when it is first required, and a source build of Vortex can run with either. What
 * settles it is the file Node loaded: `react/cjs/react.development.js` or
 * `react/cjs/react.production(.min).js`, and the same for react-dom. They are in the module
 * cache, which the renderer shares with every extension.
 */

export type ReactBuildKind = "production" | "development" | "unknown";

export interface ReactBuild {
  /** production only when both react and react-dom loaded their production builds. */
  build: ReactBuildKind;
  /** The loaded files, relative to their node_modules directory. */
  files: string[];
}

const REACT_FILE =
  /[\\/](react|react-dom)[\\/]cjs[\\/](react|react-dom)\.(development|production(?:\.min)?)\.js$/;

/** Classify the React builds among a list of loaded module paths. */
export function reactBuildFrom(moduleIds: readonly string[]): ReactBuild {
  const found = new Map<string, Set<"production" | "development">>();
  const files: string[] = [];
  for (const id of moduleIds) {
    const match = REACT_FILE.exec(id);
    if (match === null || match[1] !== match[2]) continue;
    const pkg = match[1]!;
    const kind = match[3] === "development" ? "development" : "production";
    const kinds = found.get(pkg) ?? new Set();
    kinds.add(kind);
    found.set(pkg, kinds);
    const tail = id.split(/node_modules[\\/]/).pop() ?? id;
    files.push(tail.replace(/\\/g, "/"));
  }
  const all = [...found.values()].flatMap((kinds) => [...kinds]);
  let build: ReactBuildKind = "unknown";
  if (all.includes("development")) build = "development";
  else if (found.has("react") && found.has("react-dom")) build = "production";
  return { build, files: [...new Set(files)].toSorted() };
}

/** The React build this renderer loaded, read from Node's module cache. */
export function loadedReactBuild(): ReactBuild {
  let ids: string[] = [];
  try {
    // The extension's own require shares Module._cache with Vortex's renderer.
    ids = Object.keys(require.cache);
  } catch {
    // No CommonJS module cache: report unknown rather than guess.
  }
  return reactBuildFrom(ids);
}
