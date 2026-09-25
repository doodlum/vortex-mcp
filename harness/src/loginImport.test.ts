import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { importLogin } from "./loginImport";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function dirs(): { from: string; to: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-login-import-"));
  roots.push(root);
  return { from: path.join(root, "from"), to: path.join(root, "to", "oauth-abc.json") };
}

const login = JSON.stringify({ token: "a", refreshToken: "r" });

it("copies a saved login into a new cache directory", () => {
  const { from, to } = dirs();
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, "oauth-abc.json"), login);
  importLogin(from, to);
  expect(fs.readFileSync(to, "utf8")).toBe(login);
});

it("refuses a missing or logged-out source and an existing login without --force", () => {
  const { from, to } = dirs();
  expect(() => importLogin(from, to)).toThrow(/No saved login/);
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, "oauth-abc.json"), "null");
  expect(() => importLogin(from, to)).toThrow(/logged out/);
  fs.writeFileSync(path.join(from, "oauth-abc.json"), login);
  fs.mkdirSync(path.dirname(to));
  fs.writeFileSync(to, JSON.stringify({ token: "b", refreshToken: "s" }));
  expect(() => importLogin(from, to)).toThrow(/--force/);
  importLogin(from, to, true);
  expect(fs.readFileSync(to, "utf8")).toBe(login);
});
