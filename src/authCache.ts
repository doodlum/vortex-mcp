import fs from "node:fs";
import path from "node:path";
import type { types } from "@nexusmods/vortex-api";

interface Credentials {
  token: string;
  refreshToken: string;
  fingerprint?: string;
}

function credentials(value: unknown): Credentials | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<Credentials>;
  return typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.refreshToken === "string" &&
    candidate.refreshToken.length > 0 &&
    (candidate.fingerprint === undefined || typeof candidate.fingerprint === "string")
    ? (candidate as Credentials)
    : undefined;
}

/** Stock Vortex migration that logs out every profile whose prior version is < 1.9.0. */
export const FORCED_LOGOUT_MIGRATION = "forceLogoutForOauth_1_9";

/** Harness-only local persistence. No credential is exposed as an MCP result. */
export function installAuthCache(api: types.IExtensionApi, file: string): () => void {
  const store = api.store;
  if (store === undefined) throw new Error("Vortex state store is not ready for the OAuth cache.");
  const nexusState = (): { OAuthCredentials?: unknown; ForcedLogout?: unknown } | undefined =>
    (api.getState().confidential?.account as Record<string, unknown> | undefined)?.nexus as
      | { OAuthCredentials?: unknown; ForcedLogout?: unknown }
      | undefined;
  const read = (): Credentials | undefined => credentials(nexusState()?.OAuthCredentials);
  // A source build reports version 1.0.0, so on its second launch the stock
  // migration below clears every login (the first launch skips migrations with
  // "Invalid Version" because the prior version is ""). Harness profiles never
  // held pre-OAuth logins; mark it applied before migrate() runs after `once`.
  const applied = (api.getState() as { app?: { migrations?: unknown } }).app?.migrations;
  if (!Array.isArray(applied) || !applied.includes(FORCED_LOGOUT_MIGRATION))
    store.dispatch({ type: "COMPLETE_MIGRATION", payload: FORCED_LOGOUT_MIGRATION });
  // This file is newer than any saved profile: refresh-token rotation must
  // survive --fresh and switching games. Only Vortex exchanges the token.
  if (fs.existsSync(file)) {
    let cached: Credentials | undefined;
    let loggedOut = false;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      loggedOut = value === null;
      cached = credentials(value);
    } catch {
      throw new Error(
        "The local OAuth cache is unreadable. Preserve it and run setup --oauth with a new cache directory.",
      );
    }
    if (cached === undefined && !loggedOut)
      throw new Error(
        "The local OAuth cache is invalid. Run setup --oauth with a new cache directory.",
      );
    store.dispatch(
      loggedOut
        ? { type: "CLEAR_OAUTH_CREDENTIALS", payload: null }
        : { type: "SET_OAUTH_CREDENTIALS", payload: cached },
    );
  }
  let previous = "";
  let last: Credentials | undefined;
  let pendingClear = false;
  // The migration dispatches CLEAR_OAUTH_CREDENTIALS and then, synchronously,
  // SET_FORCED_LOGOUT(true). A user's Log out (or a refused session) never sets
  // that flag, so decide after the dispatch sequence finishes.
  const settleClear = (): void => {
    pendingClear = false;
    if (read() !== undefined) return persist();
    if (nexusState()?.ForcedLogout === true && last !== undefined) {
      // Automated logout: put the login back and drop the "log in again" prompt.
      store.dispatch({ type: "SET_OAUTH_CREDENTIALS", payload: last });
      store.dispatch({ type: "SET_FORCED_LOGOUT", payload: false });
      return;
    }
    // A tombstone prevents --fresh resurrecting credentials from an old snapshot.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "null", { mode: 0o600 });
    previous = "";
    last = undefined;
  };
  const persist = (): void => {
    const current = read();
    const serialized = current === undefined ? "" : JSON.stringify(current);
    if (serialized === previous) return;
    if (current === undefined) {
      if (!pendingClear) {
        pendingClear = true;
        queueMicrotask(settleClear);
      }
      return;
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, serialized, { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    previous = serialized;
    last = current;
  };
  persist();
  return store.subscribe(persist);
}
