/**
 * Reuse this machine's saved Nexus OAuth login in another cache directory, so
 * a new `--cache-dir` needs no second interactive login and nobody copies
 * credential files by hand. Never prints credentials.
 */
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./config";

function isCredentials(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const { token, refreshToken } = value as { token?: unknown; refreshToken?: unknown };
  return (
    typeof token === "string" &&
    token.length > 0 &&
    typeof refreshToken === "string" &&
    refreshToken.length > 0
  );
}

function readCache(file: string): "missing" | "logged-out" | "invalid" | "credentials" {
  if (!fs.existsSync(file)) return "missing";
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value === null) return "logged-out";
    return isCredentials(value) ? "credentials" : "invalid";
  } catch {
    return "invalid";
  }
}

/** Copies `<fromDir>/<basename of destination>` to `destination`. Returns the source path. */
export function importLogin(fromDir: string, destination: string, force = false): string {
  const source = path.join(path.resolve(fromDir), path.basename(destination));
  if (path.resolve(source) === path.resolve(destination))
    throw new ConfigError("login-import --from names the cache directory already in use.");
  const state = readCache(source);
  if (state !== "credentials")
    throw new ConfigError(
      state === "missing"
        ? `No saved login for this target in ${fromDir}. Run setup --oauth there first.`
        : state === "logged-out"
          ? `The login in ${fromDir} was logged out. Run setup --oauth to log in again.`
          : `The saved login in ${fromDir} is unreadable; run setup --oauth.`,
    );
  if (!force && readCache(destination) === "credentials")
    throw new ConfigError("This cache already holds a login. Pass --force to replace it.");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, destination);
  return source;
}
