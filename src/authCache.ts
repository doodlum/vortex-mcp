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

/** Harness-only local persistence. No credential is exposed as an MCP result. */
export function installAuthCache(api: types.IExtensionApi, file: string): () => void {
  const store = api.store;
  if (store === undefined) throw new Error("Vortex state store is not ready for the OAuth cache.");
  const read = (): Credentials | undefined => {
    const nexus = (api.getState().confidential?.account as Record<string, unknown> | undefined)
      ?.nexus as { OAuthCredentials?: unknown } | undefined;
    return credentials(nexus?.OAuthCredentials);
  };
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
  const persist = (): void => {
    const current = read();
    const serialized = current === undefined ? "" : JSON.stringify(current);
    if (serialized === previous) return;
    if (current === undefined) {
      // A tombstone prevents --fresh resurrecting credentials from an old snapshot.
      fs.writeFileSync(file, "null", { mode: 0o600 });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, serialized, { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    previous = serialized;
  };
  persist();
  return store.subscribe(persist);
}
