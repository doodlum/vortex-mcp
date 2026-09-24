import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseJson, readJsonFile, stripBom } from "./jsonFile";

describe("JSON read back from files", () => {
  it("accepts a file PowerShell 5.1 wrote with a byte-order mark", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-bom-"));
    try {
      const file = path.join(dir, "baseline.json");
      // What `Out-File -Encoding utf8` writes: EF BB BF, then the text.
      fs.writeFileSync(
        file,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]),
      );
      expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).toThrow();
      expect(readJsonFile(file)).toEqual({ a: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves text without a mark, and marks elsewhere, alone", () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(parseJson('{"a":"﻿"}')).toEqual({ a: "﻿" });
  });
});
