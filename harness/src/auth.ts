import { ConfigError } from "./config";
import type { VortexMcpClient } from "./mcpClient";

export interface AuthStatus {
  apiKeyPresent: boolean;
  oauthPresent: boolean;
  oauthRefreshable: boolean;
}

export async function requireOAuth(mcp: VortexMcpClient): Promise<AuthStatus> {
  const status = await mcp.call<AuthStatus>("nexus_auth_status");
  if (status.oauthPresent !== true || status.oauthRefreshable !== true) {
    throw new ConfigError(
      "Nexus OAuth setup is incomplete. Run `pnpm run ai -- setup --oauth`, " +
        "complete login in the browser once; setup caches it automatically. " +
        "An API key alone cannot authenticate collections. Credentials are never printed.",
    );
  }
  return status;
}

export async function waitForOAuth(mcp: VortexMcpClient, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await mcp.call<AuthStatus>("nexus_auth_status");
    if (status.oauthPresent && status.oauthRefreshable) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new ConfigError(
    "OAuth setup is still pending. Finish login in the open Vortex window, then run save-login. The profile is preserved.",
  );
}
