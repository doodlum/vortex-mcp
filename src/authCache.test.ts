import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { types } from "@nexusmods/vortex-api";
import { installAuthCache } from "./authCache";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("restores the latest OAuth cache, persists rotation, and records logout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-auth-cache-"));
  roots.push(root);
  const file = path.join(root, "oauth.json");
  const credentials = {
    token: "test-access",
    refreshToken: "test-refresh",
    fingerprint: "test-fingerprint",
  };
  fs.writeFileSync(file, JSON.stringify(credentials));
  const nexus = {
    OAuthCredentials: { ...credentials, refreshToken: "stale-snapshot" } as
      | typeof credentials
      | undefined,
  };
  let listener: () => void = vi.fn();
  const dispatch = vi.fn((action: { type: string; payload: typeof credentials }) => {
    nexus.OAuthCredentials = action.type === "CLEAR_OAUTH_CREDENTIALS" ? undefined : action.payload;
  });
  const api = {
    getState: () => ({ confidential: { account: { nexus } } }),
    store: {
      dispatch,
      subscribe: (fn: () => void) => {
        listener = fn;
        return () => undefined;
      },
    },
  } as unknown as types.IExtensionApi;
  installAuthCache(api, file);
  expect(nexus.OAuthCredentials?.refreshToken).toBe("test-refresh");
  nexus.OAuthCredentials = { ...credentials, refreshToken: "rotated-refresh" };
  listener();
  expect(JSON.parse(fs.readFileSync(file, "utf8")).refreshToken).toBe("rotated-refresh");
  nexus.OAuthCredentials = undefined;
  listener();
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toBeNull();
  nexus.OAuthCredentials = credentials;
  installAuthCache(api, file);
  expect(nexus.OAuthCredentials).toBeUndefined();
});
