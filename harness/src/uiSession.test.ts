import { describe, expect, it } from "vitest";
import type { VortexMcpClient } from "./mcpClient";
import { withUiLock } from "./uiSession";

describe("UI transactions", () => {
  it("allows nested snapshots and keeps a watcher behind the action", async () => {
    const client = {} as VortexMcpClient;
    const events: string[] = [];
    await Promise.all([
      withUiLock(client, async () => {
        await withUiLock(client, async () => {
          events.push("snapshot");
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("click");
      }),
      withUiLock(client, async () => {
        events.push("watcher snapshot");
      }),
    ]);
    expect(events).toEqual(["snapshot", "click", "watcher snapshot"]);
  });

  it("releases after failure so recovery can snapshot again", async () => {
    const client = {} as VortexMcpClient;
    await expect(
      withUiLock(client, async () => {
        throw new Error("stale");
      }),
    ).rejects.toThrow("stale");
    await expect(withUiLock(client, async () => "recovered")).resolves.toBe("recovered");
  });
});
