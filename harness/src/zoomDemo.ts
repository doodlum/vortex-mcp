/** Capture short, real-time zoom demonstrations against a running source build. */
import path from "node:path";
import { expect } from "@playwright/test";
import { attachToRenderer, captureScreenshot, realWheel } from "./cdp";
import { loadConfig } from "./config";
import { VortexMcpClient } from "./mcpClient";
import { startRecording } from "./recording";
import { bootstrap } from "./bootstrap";

const encoder = process.argv[2];
if (!encoder) throw new Error("Usage: tsx harness/src/zoomDemo.ts <ffmpeg executable>");
const base = loadConfig({ artifactDir: path.resolve("harness/.artifacts/zoom-media") });
const anonymous = process.argv.includes("--signed-out");
const config = anonymous
  ? loadConfig({
      ...base,
      apiKey: undefined,
      cacheDir: path.join(base.cacheDir, "zoom-signed-out"),
      mcpPort: base.mcpPort + 1,
      cdpPort: base.cdpPort + 1,
    })
  : base;
const owned = anonymous
  ? (await bootstrap(config, { skipGame: true, onProgress: console.log })).instance
  : undefined;
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
const handle = await attachToRenderer(config);
const page = handle.page;
const originalMotion = await page.evaluate(() =>
  document.documentElement.getAttribute("data-reduce-motion"),
);
const originalZoom = await mcp.call<number>("vortex_query", {
  path: ["settings", "window", "zoomFactor"],
});
const originalViewport = await mcp.call<{ window: { width: number; height: number } }>(
  "ui_get_viewport",
);
const setZoom = (factor: number) =>
  mcp.call("vortex_dispatch", { action: "setZoomFactor", args: [factor] });
const popup = page.getByTestId("zoom-popover");
const signedIn = await mcp.call<boolean>("vortex_query", { selector: "isLoggedIn" });
const prefix = signedIn ? "signed-in" : "signed-out";
try {
  if (anonymous) expect(signedIn).toBe(false);
  await page.evaluate(() => document.documentElement.removeAttribute("data-reduce-motion"));
  await mcp.call("ui_set_viewport", { width: 1280, height: 720 });
  // Establish pointer modality before recording; synthetic clicks do not update
  // Chromium's :focus-visible heuristic.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await setZoom(1);
  await expect(page.getByTestId("zoom-control")).toHaveCount(0);
  const recording = await startRecording(config, {
    encoder,
    label: `${prefix}-zoom-shortcuts`,
    handle,
  });
  try {
    await page.waitForTimeout(800);
    for (let step = 0; step < 3; step++) {
      await realWheel(config, "body", -120, { control: true, handle });
      await page.waitForTimeout(650);
    }
    await expect(popup).toContainText("130%");
    await captureScreenshot(config, { label: `${prefix}-zoom-popup`, handle });
    await popup.getByRole("button", { name: "Zoom out", exact: true }).click();
    await page.waitForTimeout(700);
    await popup.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForTimeout(3700);
    await page.keyboard.press("Control+-");
    await page.waitForTimeout(900);
    await popup.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.waitForTimeout(3700);
    await page.keyboard.press("Control+=");
    await page.waitForTimeout(700);
    await page.keyboard.press("Control+0");
    await page.waitForTimeout(3700);
  } finally {
    console.log(await recording.stop());
  }
  if (signedIn) {
    await setZoom(1.2);
    const menuRecording = await startRecording(config, {
      encoder,
      label: "profile-zoom-controls",
      handle,
    });
    try {
      await page.waitForTimeout(700);
      await page.getByTestId("profile-menu-trigger").click();
      const row = page.getByRole("group", { name: "Zoom", exact: true });
      await expect(row).toBeVisible();
      await page.waitForTimeout(800);
      await captureScreenshot(config, { label: "profile-zoom-controls", handle });
      for (const name of ["Zoom in", "Zoom out", "Zoom out"]) {
        await row.getByRole("button", { name, exact: true }).click();
        await page.waitForTimeout(750);
      }
      await row.getByRole("button", { name: "Reset", exact: true }).click();
      await page.waitForTimeout(900);
      await page.getByTestId("profile-menu-trigger").click();
      await page.waitForTimeout(700);
    } finally {
      console.log(await menuRecording.stop());
    }
  }
} finally {
  await page.evaluate((value) => {
    if (value === null) document.documentElement.removeAttribute("data-reduce-motion");
    else document.documentElement.setAttribute("data-reduce-motion", value);
  }, originalMotion);
  await setZoom(originalZoom ?? 1);
  await mcp.call("ui_set_viewport", originalViewport.window);
  await handle.close();
  await owned?.stop();
}
