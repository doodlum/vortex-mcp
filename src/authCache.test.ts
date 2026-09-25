import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { types } from "@nexusmods/vortex-api";
import { FORCED_LOGOUT_MIGRATION, installAuthCache } from "./authCache";

interface Credentials {
  token: string;
  refreshToken: string;
  fingerprint?: string;
}

const credentials: Credentials = {
  token: "test-access",
  refreshToken: "test-refresh",
  fingerprint: "test-fingerprint",
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function cacheFile(content?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-auth-cache-"));
  roots.push(root);
  const file = path.join(root, "oauth.json");
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

/** A minimal Redux-like store with the reducers the cache relies on. */
function fakeVortex(initial?: Credentials) {
  const nexus: { OAuthCredentials?: Credentials; ForcedLogout: boolean; APIKey?: string } = {
    OAuthCredentials: initial,
    ForcedLogout: false,
  };
  const app = { migrations: [] as string[] };
  const listeners: Array<() => void> = [];
  const dispatch = (action: { type: string; payload: unknown }): void => {
    if (action.type === "CLEAR_OAUTH_CREDENTIALS") nexus.OAuthCredentials = undefined;
    if (action.type === "SET_OAUTH_CREDENTIALS")
      nexus.OAuthCredentials = { ...(action.payload as Credentials) };
    if (action.type === "SET_FORCED_LOGOUT") nexus.ForcedLogout = action.payload as boolean;
    if (action.type === "SET_USER_API_KEY") nexus.APIKey = action.payload as string;
    if (action.type === "COMPLETE_MIGRATION") app.migrations.push(action.payload as string);
    for (const listener of listeners) listener();
  };
  const api = {
    getState: () => ({ app, confidential: { account: { nexus } } }),
    store: {
      dispatch,
      subscribe: (fn: () => void) => {
        listeners.push(fn);
        return () => undefined;
      },
    },
  } as unknown as types.IExtensionApi;
  return { api, nexus, app, dispatch };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const readCache = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

it("restores the cache over an older snapshot and saves rotated credentials", async () => {
  const file = cacheFile(credentials);
  const vortex = fakeVortex({ ...credentials, refreshToken: "stale-snapshot" });
  installAuthCache(vortex.api, file);
  expect(vortex.nexus.OAuthCredentials?.refreshToken).toBe("test-refresh");
  vortex.dispatch({
    type: "SET_OAUTH_CREDENTIALS",
    payload: { ...credentials, refreshToken: "rotated-refresh" },
  });
  await settle();
  expect((readCache(file) as Credentials).refreshToken).toBe("rotated-refresh");
});

it("writes a tombstone for a user logout and honours it on the next start", async () => {
  const file = cacheFile(credentials);
  const vortex = fakeVortex();
  installAuthCache(vortex.api, file);
  vortex.dispatch({ type: "CLEAR_OAUTH_CREDENTIALS", payload: null });
  await settle();
  expect(readCache(file)).toBeNull();
  const next = fakeVortex(credentials);
  installAuthCache(next.api, file);
  expect(next.nexus.OAuthCredentials).toBeUndefined();
});

it("keeps and re-applies the login when the startup migration forces a logout", async () => {
  const file = cacheFile(credentials);
  const vortex = fakeVortex();
  installAuthCache(vortex.api, file);
  // What forceLogoutForOauth_1_9 dispatches, synchronously and in this order.
  vortex.dispatch({ type: "SET_USER_API_KEY", payload: undefined });
  vortex.dispatch({ type: "CLEAR_OAUTH_CREDENTIALS", payload: null });
  vortex.dispatch({ type: "SET_FORCED_LOGOUT", payload: true });
  await settle();
  expect(readCache(file)).toEqual(credentials);
  expect(vortex.nexus.OAuthCredentials).toEqual(credentials);
  expect(vortex.nexus.ForcedLogout).toBe(false);
});

it("marks the forced-logout migration applied so it does not run", () => {
  const vortex = fakeVortex();
  installAuthCache(vortex.api, cacheFile(credentials));
  expect(vortex.app.migrations).toEqual([FORCED_LOGOUT_MIGRATION]);
  installAuthCache(vortex.api, cacheFile(credentials));
  expect(vortex.app.migrations).toEqual([FORCED_LOGOUT_MIGRATION]);
});
