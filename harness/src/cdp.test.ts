import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureScreenshot, realWheel } from "./cdp";
import type { HarnessConfig } from "./config";

describe("realWheel", () => {
  it("releases Control even if the native wheel call fails", async () => {
    const page = {
      hover: vi.fn().mockResolvedValue(undefined),
      keyboard: { down: vi.fn(), up: vi.fn() },
      mouse: { wheel: vi.fn().mockRejectedValue(new Error("disconnected")) },
    };
    const close = vi.fn();
    await expect(
      realWheel({} as HarnessConfig, "body", -120, {
        control: true,
        handle: { page: page as unknown as Page, close },
      }),
    ).rejects.toThrow("disconnected");
    expect(page.keyboard.down).toHaveBeenCalledWith("Control");
    expect(page.keyboard.up).toHaveBeenCalledWith("Control");
    expect(close).not.toHaveBeenCalled();
  });
});

it("captures the native viewport without a CSS-pixel clip at non-default zoom", async () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-capture-test-"));
  const data = Buffer.from("captured image");
  const session = {
    send: vi.fn().mockResolvedValue({ data: data.toString("base64") }),
    detach: vi.fn(),
  };
  const page = { context: () => ({ newCDPSession: vi.fn().mockResolvedValue(session) }) };
  try {
    const file = await captureScreenshot({ artifactDir } as HarnessConfig, {
      handle: { page: page as unknown as Page, close: vi.fn() },
    });
    expect(session.send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    expect(fs.readFileSync(file)).toEqual(data);
    expect(session.detach).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});
