/**
 * `vortex-ai eval`: run JavaScript in a harness Vortex's renderer over CDP, for diagnostics.
 *
 * For questions the MCP tools do not answer yet: a component's props, a computed style, what
 * a private object holds. It is a diagnostic, not a way to drive Vortex: anything a test or
 * a workflow relies on belongs in an extension tool or a harness helper (AGENTS.md), where
 * it is reviewed and covered.
 *
 * It refuses anything but a harness instance of this cache: the MCP server on the configured
 * port must report a userData directory inside the cache (the same check `down` makes), and
 * the renderer reached over CDP must report that same directory. The operator's own Vortex
 * never has CDP open, and this never attaches to it.
 */
import path from "node:path";

import { attachToRenderer } from "./cdp";
import type { HarnessConfig } from "./config";
import { VortexMcpClient } from "./mcpClient";

export class RendererEvalRefused extends Error {}

/** Whether `userDataDir` is inside the harness cache. */
export function isHarnessProfile(
  cacheDir: string,
  userDataDir: string | null | undefined,
): boolean {
  if (userDataDir === null || userDataDir === undefined || userDataDir === "") return false;
  const relative = path.relative(path.resolve(cacheDir), path.resolve(userDataDir));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const sameDir = (a: string, b: string): boolean =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The page's own ELECTRON_USERDATA, when the renderer can see `process` (Vortex's can). */
const RENDERER_USERDATA = `(() => {
  try { return typeof process !== "undefined" ? (process.env.ELECTRON_USERDATA ?? null) : null; }
  catch { return null; }
})()`;

export interface EvalResult {
  value: unknown;
  userDataDir: string;
  /** Whether the renderer itself confirmed the profile (it could not when `process` is hidden). */
  rendererConfirmed: boolean;
}

/**
 * Evaluate `source` as an expression in the renderer; a promise is awaited. Use an async
 * IIFE for statements: `(async () => { …; return x; })()`.
 */
export async function evalInRenderer(config: HarnessConfig, source: string): Promise<EvalResult> {
  const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
  if (!(await mcp.ping())) {
    throw new RendererEvalRefused(
      `No harness Vortex is answering on ${mcp.url}. Start one with \`up\`.`,
    );
  }
  const status = await mcp.call<{ userDataDir: string | null }>("automation_status");
  if (!isHarnessProfile(config.cacheDir, status.userDataDir) || status.userDataDir === null) {
    throw new RendererEvalRefused(
      `The Vortex on port ${String(config.mcpPort)} is not a harness instance of ${config.cacheDir} ` +
        `(its profile: ${String(status.userDataDir)}). eval only runs in harness instances.`,
    );
  }
  const handle = await attachToRenderer(config);
  try {
    const seen = (await handle.page.evaluate(RENDERER_USERDATA)) as string | null;
    if (seen !== null && !sameDir(seen, status.userDataDir)) {
      throw new RendererEvalRefused(
        `CDP port ${String(config.cdpPort)} reaches a renderer with profile ${seen}, not the ` +
          `harness instance's ${status.userDataDir}. Pass the instance's --cdp-port.`,
      );
    }
    const value: unknown = await handle.page.evaluate(source);
    return { value, userDataDir: status.userDataDir, rendererConfirmed: seen !== null };
  } finally {
    await handle.close();
  }
}
