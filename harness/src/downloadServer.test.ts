import { afterEach, describe, expect, it } from "vitest";

import { startDownloadServer, type DownloadServer } from "./downloadServer";

let server: DownloadServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("startDownloadServer", () => {
  it("serves the whole file, no faster than the rate asked for", async () => {
    server = await startDownloadServer({ sizeBytes: 50_000, bytesPerSecond: 100_000 });
    const start = Date.now();
    const response = await fetch(server.url("mod archive.zip"));
    const body = await response.arrayBuffer();
    expect(response.status).toBe(200);
    expect(body.byteLength).toBe(50_000);
    expect(response.headers.get("content-disposition")).toContain("mod archive.zip");
    // 50kB at 100kB/s is half a second; allow for the first tick
    expect(Date.now() - start).toBeGreaterThanOrEqual(350);
  });

  it("resumes from a byte range", async () => {
    server = await startDownloadServer({ sizeBytes: 10_000, bytesPerSecond: 1_000_000 });
    const response = await fetch(server.url("x.zip"), { headers: { range: "bytes=4000-" } });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(6_000);
    expect(response.headers.get("content-range")).toBe("bytes 4000-9999/10000");
  });

  it("serves exactly a closed range, as Vortex's chunked downloads ask for", async () => {
    server = await startDownloadServer({ sizeBytes: 10_000, bytesPerSecond: 1_000_000 });
    const response = await fetch(server.url("x.zip"), { headers: { range: "bytes=100-2099" } });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(2_000);
    expect(response.headers.get("content-range")).toBe("bytes 100-2099/10000");
  });
});
