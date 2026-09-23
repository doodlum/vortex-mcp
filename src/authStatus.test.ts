import { describe, expect, it } from "vitest";
import { authStatus } from "./authStatus";

describe("authentication status", () => {
  it.each([
    [undefined, false, false, false],
    [{ APIKey: "secret" }, true, false, false],
    [{ OAuthCredentials: {} }, false, false, false],
    [{ OAuthCredentials: { token: "access", refreshToken: "refresh" } }, false, true, true],
  ])("exposes presence without disclosing credentials", (nexus, apiKey, oauth, refresh) => {
    expect(
      authStatus({ getState: () => ({ confidential: { account: { nexus } } }) } as never),
    ).toEqual({ apiKeyPresent: apiKey, oauthPresent: oauth, oauthRefreshable: refresh });
  });
});
