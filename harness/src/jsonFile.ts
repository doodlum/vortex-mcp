/**
 * Reading back JSON that a person or another tool may have written.
 *
 * Windows PowerShell 5.1's `Out-File -Encoding utf8` and `Set-Content -Encoding utf8` start
 * the file with a UTF-8 byte-order mark, and `JSON.parse` rejects it ("Unexpected token"),
 * so a baseline report or an arguments file saved from PowerShell looks corrupt. Every JSON
 * file the kit reads back goes through here.
 */
import fs from "node:fs";

const BOM = "﻿";

/** `text` without a leading byte-order mark. */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/** `JSON.parse`, tolerating a leading byte-order mark. */
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(stripBom(text)) as T;
}

/** Read and parse a JSON file, tolerating a leading byte-order mark. */
export function readJsonFile<T = unknown>(file: string): T {
  return parseJson<T>(fs.readFileSync(file, "utf8"));
}
