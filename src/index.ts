import type { types } from "@nexusmods/vortex-api";
import { startMcpServer } from "./mcpServer";
import { installConsoleCapture } from "./uiAutomation";
import { installAuthCache } from "./authCache";

type IExtensionContext = types.IExtensionContext;

function main(context: IExtensionContext): void {
  context.once(() => {
    // Before the server starts, so the buffer covers everything from load
    // onwards rather than only what happens once a client first connects.
    // Idempotent.
    installConsoleCapture();
    if (process.env.VORTEX_E2E === "1" && process.env.VORTEX_AI_AUTH_CACHE) {
      installAuthCache(context.api, process.env.VORTEX_AI_AUTH_CACHE);
    }
    startMcpServer(context.api);
  });
}

export default main;
