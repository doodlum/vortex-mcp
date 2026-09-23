import fs from "node:fs";
import path from "node:path";
import { ANONYMOUS, bootstrap, captureLogin, liveDir, readMarker, snapshotDir } from "../bootstrap";
import { stopStaleInstance } from "../instance";
import { test, expect, freePort } from "./fixtures";
import { sandboxConfig } from "../sandbox";

test("cold, warm and fresh starts preserve only the intended profile state", async ({
  config: parentConfig,
}) => {
  test.setTimeout(240_000);
  const config = sandboxConfig({
    ...parentConfig,
    cacheDir: path.join(parentConfig.cacheDir, "lifecycle"),
    mcpPort: await freePort(),
    cdpPort: await freePort(),
  });
  const messages: string[] = [];
  const options = { skipGame: true, onProgress: (message: string) => messages.push(message) };
  try {
    const cold = await bootstrap(config, options);
    expect(cold.tier).toBe("cold");
    expect(readMarker(snapshotDir(config, ANONYMOUS, true))?.gameSkipped).toBe(true);
    const sentinel = path.join(liveDir(config), "userData", "warm-sentinel.txt");
    fs.writeFileSync(sentinel, "keep on warm start");
    await expect(captureLogin(config)).rejects.toThrow(/OAuth/i);
    expect(await cold.instance.mcp.ping()).toBe(true);

    const warm = await bootstrap(config, options);
    expect(warm.tier).toBe("warm");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep on warm start");
    const reset = await bootstrap(config, { ...options, fresh: true });
    expect(reset.tier).toBe("reset");
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(await reset.instance.mcp.call("nexus_auth_status")).toEqual({
      apiKeyPresent: false,
      oauthPresent: false,
      oauthRefreshable: false,
    });

    const managed = await bootstrap(config);
    expect(managed.tier).toBe("cold");
    expect(managed.game.activated).toBe(true);
    expect(readMarker(liveDir(config))?.gameSkipped).toBe(false);
    expect(await managed.instance.mcp.call("vortex_query", { selector: "activeGameId" })).toBe(
      config.gameId,
    );
  } finally {
    await stopStaleInstance(config);
    await test
      .info()
      .attach("bootstrap-progress", { body: messages.join("\n"), contentType: "text/plain" });
  }
});
