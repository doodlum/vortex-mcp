import type { types } from "@nexusmods/vortex-api";

/** Derived facts only: no token, account identity, or credential leaves Vortex. */
export function authStatus(api: types.IExtensionApi): {
  apiKeyPresent: boolean;
  oauthPresent: boolean;
  oauthRefreshable: boolean;
} {
  const nexus = (api.getState().confidential?.account as Record<string, unknown> | undefined)
    ?.nexus as
    | { APIKey?: string; OAuthCredentials?: { token?: string; refreshToken?: string } }
    | undefined;
  return {
    apiKeyPresent: Boolean(nexus?.APIKey),
    oauthPresent: Boolean(nexus?.OAuthCredentials?.token),
    oauthRefreshable: Boolean(nexus?.OAuthCredentials?.refreshToken),
  };
}
