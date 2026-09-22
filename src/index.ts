import type { types } from "@nexusmods/vortex-api";
import { startMcpServer } from "./mcpServer";
import { installConsoleCapture } from "./uiAutomation";

type IExtensionContext = types.IExtensionContext;

function main(context: IExtensionContext): void {
  context.once(() => {
    // Before the server starts, so the buffer covers everything from load
    // onwards rather than only what happens once a client first connects.
    // Idempotent.
    installConsoleCapture();
    startMcpServer(context.api);
  });
}

export default main;
