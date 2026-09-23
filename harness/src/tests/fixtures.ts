/**
 * Playwright fixtures that launch Vortex with vortex-mcp loaded and hand a test
 * both handles: Playwright's `Page` for the renderer, and an MCP client for the
 * AI automation tools.
 *
 * Having both is the point. The MCP client is what an agent actually uses, so
 * that is what these tests exercise; Playwright's `Page` is the independent
 * check — when `ui_click` claims it clicked something, Playwright can confirm
 * the DOM really changed. A test that asserted through the same MCP tools it
 * was testing would be marking its own homework.
 *
 * Unlike src/instance.ts this uses `_electron.launch`, because a test genuinely
 * does want the app to die with it.
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";

import {
  test as base,
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { loadConfig, type HarnessConfig } from "../config";
import { sandboxConfig, installSandboxExtension } from "../sandbox";
import { ensureGameManaged } from "../gameSetup";
import {
  buildInstanceEnv,
  ensureExtensionBuilt,
  installMcpExtension,
  prepareUserDataDir,
  removeInstanceDir,
} from "../instance";
import { VortexMcpClient } from "../mcpClient";

export interface AiFixtures {
  config: HarnessConfig;
  /** Isolated user-data directory for this test file. */
  userDataDir: string;
  vortexApp: ElectronApplication;
  /** The renderer window — the independent oracle for what the MCP tools did. */
  vortexWindow: Page;
  /** MCP client against the extension inside this instance. */
  mcp: VortexMcpClient;
  /** An instance with the configured game managed and active. */
  managedGame: { gameId: string; gamePath: string };
}

/**
 * No test-scoped fixtures: every fixture here is worker-scoped, because
 * launching Vortex costs minutes of Electron startup and nothing in these tests
 * needs a pristine app per assertion.
 *
 * `Record<string, never>` would look like the empty type but actually declares
 * an index signature that swallows the worker fixtures below.
 */
type NoTestFixtures = Record<never, never>;

export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

export const test = base.extend<NoTestFixtures, AiFixtures>({
  config: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-ai-test-"));
      const mcpPort = await freePort();
      let cdpPort = await freePort();
      while (cdpPort === mcpPort) cdpPort = await freePort();
      try {
        await use(sandboxConfig(loadConfig({ cacheDir, mcpPort, cdpPort, apiKey: undefined })));
      } finally {
        removeInstanceDir(cacheDir);
      }
    },
    { scope: "worker" },
  ],

  userDataDir: [
    async ({ config }, use) => {
      // A dedicated temp directory rather than the shared .cache/live one: these
      // tests install mods and resize windows, and must not disturb a working
      // instance the operator has up.
      const dir = path.join(config.cacheDir, "instance");
      prepareUserDataDir(dir, config.target.appName);
      await ensureExtensionBuilt();
      installMcpExtension(dir);
      installSandboxExtension(dir, config);
      await use(dir);
      removeInstanceDir(dir);
    },
    { scope: "worker" },
  ],

  vortexApp: [
    async ({ config, userDataDir }, use) => {
      // Whatever the config resolved — a released Vortex.exe by default, or an
      // Electron pointed at a source checkout. CDP is opened so the screenshot
      // helpers can attach alongside Playwright's own connection.
      const app = await electron.launch({
        executablePath: config.target.executable,
        args: [...config.target.args, `--remote-debugging-port=${String(config.cdpPort)}`],
        env: buildInstanceEnv(userDataDir, config),
        cwd: path.dirname(config.target.executable),
        timeout: 180_000,
      });
      await use(app);
      await app.close().catch(() => undefined);
    },
    { scope: "worker" },
  ],

  vortexWindow: [
    async ({ vortexApp }, use) => {
      // Vortex opens a splash window first, so take the one showing index.html
      // rather than whichever appears first.
      const deadline = Date.now() + 180_000;
      let main: Page | undefined;
      while (Date.now() < deadline) {
        main = vortexApp.windows().find((w) => w.url().includes("index.html"));
        if (main !== undefined) break;
        await vortexApp.waitForEvent("window", { timeout: 10_000 }).catch(() => undefined);
      }
      if (main === undefined) throw new Error("Vortex's main window never appeared.");
      await use(main);
    },
    { scope: "worker" },
  ],

  mcp: [
    async ({ config, vortexWindow }, use) => {
      // Depends on vortexWindow so the renderer is up before we start polling.
      void vortexWindow;
      const client = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
      await client.waitUntilReady();
      await use(client);
    },
    { scope: "worker" },
  ],

  managedGame: [
    async ({ config, mcp }, use) => {
      const game = await ensureGameManaged(mcp, config.gameId, {
        gamePath: config.gamePath,
        config,
      });
      await use({ gameId: game.gameId, gamePath: game.gamePath });
    },
    { scope: "worker" },
  ],
});

export { expect };
