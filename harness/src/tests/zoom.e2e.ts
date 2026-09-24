/** Opt-in feature check against a running source build: pnpm run ai:test:zoom. */
import path from "node:path";
import { expect } from "@playwright/test";
import { attachToRenderer, captureScreenshot, realWheel } from "../cdp";
import { loadConfig } from "../config";
import { VortexMcpClient } from "../mcpClient";
import { clickByName } from "../uiDriver";
import { bootstrap } from "../bootstrap";
import { claimInstanceLease } from "../instance";

const signedOut = process.argv.includes("--signed-out");
const baseConfig = loadConfig();
const config = signedOut
  ? loadConfig({
      apiKey: undefined,
      cacheDir: path.join(baseConfig.cacheDir, "zoom-signed-out"),
      artifactDir: path.join(baseConfig.artifactDir, "zoom-signed-out"),
      mcpPort: baseConfig.mcpPort + 1,
      cdpPort: baseConfig.cdpPort + 1,
    })
  : baseConfig;
// Drives (or, signed out, starts) an instance: refuse while another owner holds it.
claimInstanceLease(config, "ai:test:zoom", {}, { attach: true });
const ownedInstance = signedOut
  ? (await bootstrap(config, { skipGame: true, onProgress: console.log })).instance
  : undefined;
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
const handle = await attachToRenderer(config);
const page = handle.page;
const originalZoom = await mcp.call<number>("vortex_query", {
  path: ["settings", "window", "zoomFactor"],
});
const originalLayout = await mcp.call<boolean>("vortex_query", {
  path: ["settings", "window", "useModernLayout"],
});
let layoutChanged = false;
const originalViewport = await mcp.call<{ window: { width: number; height: number } }>(
  "ui_get_viewport",
);
const setZoom = (factor: number) =>
  mcp.call("vortex_dispatch", { action: "setZoomFactor", args: [factor] });
const actualZoom = () => page.evaluate(() => Number(document.documentElement.style.zoom || 1));
const profilePosition = () =>
  page.evaluate(() => {
    const rect = document
      .querySelector('[data-testid="profile-menu-trigger"]')
      ?.getBoundingClientRect();
    const zoom = require("electron").webFrame.getZoomFactor() as number;
    return rect ? [rect.x * zoom, rect.y * zoom] : null;
  });

async function waitForPanel(selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(selector)
        .evaluate(
          (element) => getComputedStyle(element.closest(".nxm-popover-panel") ?? element).opacity,
        ),
    )
    .toBe("1");
}

async function clickZoomTrigger() {
  await expect(page.getByTestId("zoom-control")).toBeVisible();
  await expect
    .poll(() =>
      page.getByTestId("zoom-control").evaluate((element) => {
        let opacity = 1;
        for (let node: Element | null = element; node; node = node.parentElement)
          opacity *= Number(getComputedStyle(node).opacity);
        return opacity;
      }),
    )
    .toBe(1);
  await clickByName(mcp, { testId: "zoom-control" });
}

// Electron reports DOM geometry in zoomed CSS pixels. Compare window coordinates.
const chromeBounds = () =>
  page.evaluate(() => {
    const zoom = require("electron").webFrame.getZoomFactor() as number;
    const selectors = [
      '[data-testid="window-titlebar"], #main-toolbar',
      '[data-testid="zoom-control"]',
      '[data-testid="zoom-popover"]',
      '[data-testid="zoom-popover"] button',
      '[data-testid="window-titlebar"] button[aria-label="Close"], #window-controls',
    ];
    return selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((element) => {
        const rect = element.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height].map((value) => value * zoom);
      }),
    );
  });

async function checkFixedChrome(label: string) {
  const baseline = await chromeBounds();
  expect(baseline.length).toBeGreaterThanOrEqual(6);
  expect(
    Math.abs(baseline[1]![0]! + baseline[1]![2]! / 2 - (baseline[2]![0]! + baseline[2]![2]! / 2)),
  ).toBeLessThan(2);
  for (const factor of [0.5, 0.9, 1.1, 1.5]) {
    await setZoom(factor);
    await expect.poll(actualZoom).toBeCloseTo(factor);
    await expect
      .poll(
        async () => {
          const bounds = await chromeBounds();
          if (bounds.length !== baseline.length) return Infinity;
          return Math.max(
            ...bounds.flatMap((rect, i) =>
              rect.map((value, j) => Math.abs(value - baseline[i]![j]!)),
            ),
          );
        },
        { message: `${label}: title bar, popup and buttons stay fixed at ${factor * 100}%` },
      )
      .toBeLessThan(2);
    if (factor === 0.5 || factor === 1.5) {
      await captureScreenshot(config, { label: `${label}-${factor * 100}`, handle });
    }
  }
  await setZoom(1.2);
}

async function checkChromeDuringZoom() {
  await setZoom(0.5);
  await page.keyboard.press("Control+-");
  await waitForPanel('[data-testid="zoom-popover"]');
  const samplesPromise = page.evaluate(async () => {
    const frames: number[][][] = [];
    const start = performance.now();
    while (performance.now() - start < 2200) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(
        [
          '[data-testid="window-titlebar"]',
          '[data-testid="zoom-control"]',
          '[data-testid="zoom-popover"]',
        ].map((selector) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        }),
      );
    }
    return frames;
  });
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press("Control+=");
    await page.waitForTimeout(100);
  }
  const frames = await samplesPromise;
  expect(frames.length).toBeGreaterThan(10);
  const baseline = frames[0]!;
  expect(
    Math.max(
      ...frames.flatMap((frame) =>
        frame.flatMap((rect, i) => rect.map((value, j) => Math.abs(value - baseline[i]![j]!))),
      ),
    ),
    "chrome does not move during any zoom frame",
  ).toBeLessThan(2);
  await page.keyboard.press("Escape");
  await setZoom(1);
  await expect(page.getByTestId("zoom-control")).toHaveCount(0);
}

async function checkZoomMotion(reduced: boolean) {
  await setZoom(1);
  await expect(page.getByTestId("zoom-control")).toHaveCount(0);
  const samples = await page.evaluate(async (reduceMotion) => {
    const root = document.documentElement;
    const original = root.getAttribute("data-reduce-motion");
    // Exercise the app's published motion contract without changing the user's preference.
    if (reduceMotion) root.setAttribute("data-reduce-motion", "true");
    else root.removeAttribute("data-reduce-motion");
    const frameSamples: {
      width: number;
      opacity: number | null;
      profileX: number | null;
      centerDelta: number | null;
      duration: number;
      elapsed: number;
    }[] = [];
    try {
      const start = performance.now();
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true, cancelable: true }),
      );
      while (performance.now() - start < 3400) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const slot = document.querySelector('[data-testid="zoom-control-slot"]')!;
        const button = document
          .querySelector('[data-testid="zoom-control"]')
          ?.getBoundingClientRect();
        const popup = document.querySelector('[data-testid="zoom-popover"]');
        const panel = popup?.getBoundingClientRect();
        frameSamples.push({
          width: slot.getBoundingClientRect().width,
          opacity: popup ? Number(getComputedStyle(popup).opacity) : null,
          profileX:
            document.querySelector('[data-testid="profile-menu-trigger"]')?.getBoundingClientRect()
              .x ?? null,
          centerDelta:
            button && panel
              ? Math.abs(button.x + button.width / 2 - panel.x - panel.width / 2)
              : null,
          duration: parseFloat(getComputedStyle(slot).transitionDuration),
          elapsed: performance.now() - start,
        });
      }
      return frameSamples;
    } finally {
      if (original === null) root.removeAttribute("data-reduce-motion");
      else root.setAttribute("data-reduce-motion", original);
    }
  }, reduced);
  expect(Math.max(...samples.map((sample) => sample.width))).toBeCloseTo(36, 0);
  expect(samples.at(-1)!.width).toBe(0);
  const positions = samples.flatMap((sample) =>
    sample.profileX === null ? [] : [sample.profileX],
  );
  if (positions.length) expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
  expect(Math.max(...samples.map((sample) => sample.centerDelta ?? 0))).toBeLessThan(2);
  if (reduced) {
    expect(Math.max(...samples.map((sample) => sample.duration))).toBeLessThan(0.001);
  } else {
    expect(samples.some((sample) => sample.width > 1 && sample.width < 35)).toBe(true);
    for (const exiting of [false, true]) {
      expect(
        samples.some(
          (sample) =>
            sample.elapsed >= 3000 === exiting &&
            sample.opacity !== null &&
            sample.opacity > 0.01 &&
            sample.opacity < 0.99,
        ),
        exiting ? "zoom popup fades out" : "zoom popup fades in",
      ).toBe(true);
    }
  }
  await expect(page.getByTestId("zoom-control")).toHaveCount(0);
  await expect(page.getByTestId("zoom-popover")).toHaveCount(0);
}

async function checkZoomPointerDismissal() {
  await setZoom(1.2);
  await page.getByTestId("zoom-control").click();
  await waitForPanel('[data-testid="zoom-popover"]');
  const iconSizes = await page.evaluate(() => {
    const zoom = require("electron").webFrame.getZoomFactor() as number;
    return [
      '[data-testid="zoom-control"] svg',
      '[data-testid="profile-menu-trigger"] img, [data-testid="profile-menu-trigger"] svg',
    ].map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? [rect.width * zoom, rect.height * zoom] : null;
    });
  });
  expect(iconSizes[0]![0]).toBeCloseTo(20, 0);
  if (iconSizes[1]) {
    expect(iconSizes[0]![0]).toBeCloseTo(iconSizes[1][0]!, 0);
    expect(iconSizes[0]![1]).toBeCloseTo(iconSizes[1][1]!, 0);
  }
  // An inert surface catches the outside-click case where no other control takes focus.
  await page.evaluate(() => {
    const surface = document.createElement("div");
    surface.id = "zoom-test-outside";
    surface.style.cssText =
      "position:fixed;left:300px;top:100px;width:100px;height:100px;z-index:99999";
    document.body.appendChild(surface);
  });
  try {
    await page.locator("#zoom-test-outside").click();
    await expect(page.getByTestId("zoom-control")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("zoom-popover")).toHaveCount(0);
    await expect(page.getByTestId("zoom-control")).not.toBeFocused();
    await expect
      .poll(() =>
        page
          .getByTestId("zoom-control")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgba(0, 0, 0, 0)");
  } finally {
    await page.evaluate(() => document.getElementById("zoom-test-outside")?.remove());
  }
}

async function checkButtonsAtDefault() {
  for (const [factor, name] of [
    [0.9, "Zoom in"],
    [1.1, "Zoom out"],
  ] as const) {
    await setZoom(factor);
    await clickZoomTrigger();
    await waitForPanel('[data-testid="zoom-popover"]');
    await clickByName(mcp, { role: "button", name });
    await expect.poll(actualZoom).toBe(1);
    await page.waitForTimeout(2000);
    await waitForPanel('[data-testid="zoom-popover"]');
    await expect(page.getByTestId("zoom-control")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("zoom-popover")).toHaveCount(0, { timeout: 2500 });
    await expect(page.getByTestId("zoom-control")).toHaveCount(0);
  }
}
try {
  const loggedIn = await mcp.call<boolean>("vortex_query", { selector: "isLoggedIn" });
  expect(
    loggedIn,
    signedOut ? "isolated profile is signed out" : "existing profile is signed in",
  ).toBe(!signedOut);
  if (!originalLayout) {
    await mcp.call("vortex_dispatch", { action: "type:SET_USE_MODERN_LAYOUT", args: [true] });
    layoutChanged = true;
    await page.reload();
    await mcp.waitUntilReady();
  }
  await setZoom(1);
  await expect(page.getByTestId("zoom-control")).toHaveCount(0);
  const profileWithoutZoom = await profilePosition();
  await realWheel(config, "body", -120, { handle });
  await expect.poll(actualZoom).toBe(1);
  await realWheel(config, "body", -120, { handle, control: true });
  await expect.poll(actualZoom).toBeCloseTo(1.1);
  await expect(page.getByTestId("zoom-control")).toBeVisible();
  if (profileWithoutZoom) {
    const profileWithZoom = await profilePosition();
    expect(Math.abs(profileWithZoom![0]! - profileWithoutZoom[0]!)).toBeLessThan(2);
    expect(Math.abs(profileWithZoom![1]! - profileWithoutZoom[1]!)).toBeLessThan(2);
  }
  await waitForPanel('[data-testid="zoom-popover"]');
  await page.waitForTimeout(2000);
  await realWheel(config, "body", -120, { handle, control: true });
  await expect.poll(actualZoom).toBeCloseTo(1.2);
  await page.waitForTimeout(1100);
  await waitForPanel('[data-testid="zoom-popover"]');
  await expect(page.getByTestId("zoom-popover")).toHaveCount(0, { timeout: 2500 });
  await expect(page.getByTestId("zoom-control")).toBeVisible();
  await clickZoomTrigger();
  await waitForPanel('[data-testid="zoom-popover"]');
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
  await clickByName(mcp, { role: "button", name: "Zoom in" });
  await expect.poll(actualZoom).toBeCloseTo(1.3);
  await captureScreenshot(config, { label: "zoom-popover", handle });
  await clickByName(mcp, { role: "button", name: "Reset" });
  await expect.poll(actualZoom).toBe(1);
  await expect(page.getByTestId("zoom-control")).toHaveCount(0);

  await page.keyboard.press("Control+-");
  await expect.poll(actualZoom).toBeCloseTo(0.9);
  await waitForPanel('[data-testid="zoom-popover"]');
  await page.keyboard.press("Control+=");
  await expect.poll(actualZoom).toBe(1);
  await page.keyboard.press("Control+Shift+Equal");
  await expect.poll(actualZoom).toBeCloseTo(1.1);
  await page.keyboard.press("Control+0");
  await expect.poll(actualZoom).toBe(1);
  await expect(page.getByTestId("zoom-control")).toHaveCount(0, { timeout: 4000 });
  await setZoom(1.2);
  await page.reload();
  await mcp.waitUntilReady();
  await expect.poll(actualZoom).toBeCloseTo(1.2);
  await expect(page.getByTestId("zoom-control")).toBeVisible();

  if (signedOut) {
    await expect(page.getByTestId("profile-menu-trigger")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  } else {
    await clickByName(mcp, { testId: "profile-menu-trigger" });
    const zoomRow = page.getByRole("group", { name: "Zoom", exact: true });
    await expect(zoomRow).toBeVisible();
    await waitForPanel('[role="group"][aria-label="Zoom"]');
    await expect(zoomRow.getByTestId("profile-zoom-percent")).toHaveText("120%");
    await clickByName(mcp, { role: "button", name: "Zoom out" });
    await expect.poll(actualZoom).toBeCloseTo(1.1);
    await expect(zoomRow).toBeVisible();
    await waitForPanel('[role="group"][aria-label="Zoom"]');
    await clickByName(mcp, { role: "button", name: "Zoom in" });
    await expect.poll(actualZoom).toBeCloseTo(1.2);
    await captureScreenshot(config, { label: "profile-zoom-row", handle });
    await clickByName(mcp, { role: "button", name: "Reset" });
    await expect.poll(actualZoom).toBe(1);
    await expect(zoomRow.getByTestId("profile-zoom-percent")).toHaveText("100%");
    await expect(page.getByTestId("zoom-control")).toHaveCount(0);
    await clickByName(mcp, { testId: "profile-menu-trigger" });
    await expect(zoomRow).toHaveCount(0);
    await setZoom(1.2);
  }

  for (const [width, height] of [
    [1024, 720],
    [1280, 720],
    [1280, 1000],
  ]) {
    await mcp.call("ui_set_viewport", { width, height });
    await clickZoomTrigger();
    await waitForPanel('[data-testid="zoom-popover"]');
    await expect(
      page.getByTestId("zoom-popover").getByRole("button", { name: "Zoom out", exact: true }),
    ).toBeVisible();
    await checkFixedChrome(`fixed-chrome-${width}x${height}`);
    await captureScreenshot(config, { label: `zoom-${width}x${height}`, handle });
    await mcp.call("ui_press_key", { key: "Escape" });
  }
  await setZoom(1.5);
  await realWheel(config, "body", -120, { handle, control: true });
  await expect.poll(actualZoom).toBeCloseTo(1.5);
  await waitForPanel('[data-testid="zoom-popover"]');
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
  await mcp.call("ui_press_key", { key: "Escape" });
  await setZoom(0.5);
  await realWheel(config, "body", 120, { handle, control: true });
  await expect.poll(actualZoom).toBeCloseTo(0.5);
  await mcp.call("ui_press_key", { key: "Escape" });
  await setZoom(0.9);
  await realWheel(config, "body", -120, { handle, control: true });
  await expect.poll(actualZoom).toBe(1);
  await waitForPanel('[data-testid="zoom-popover"]');
  await expect(page.getByTestId("zoom-control")).toBeVisible();
  await expect(page.getByTestId("zoom-popover")).toHaveCount(0, { timeout: 4000 });
  await expect(page.getByTestId("zoom-control")).toHaveCount(0);
  await checkZoomMotion(false);
  await checkZoomMotion(true);
  await checkButtonsAtDefault();
  await checkZoomPointerDismissal();
  await checkChromeDuringZoom();
  await mcp.call("vortex_dispatch", {
    action: "type:SET_USE_MODERN_LAYOUT",
    args: [false],
  });
  layoutChanged = true;
  await page.reload();
  await mcp.waitUntilReady();
  await expect(page.locator("#main-toolbar")).toBeVisible();
  await expect(page.getByTestId("zoom-control-slot")).toHaveCount(0);
  await expect(page.getByTestId("zoom-popover")).toHaveCount(0);
  expect(
    await page.locator("#main-toolbar").evaluate((element) => (element as HTMLElement).style.zoom),
  ).toBe("");
  expect(
    await page
      .locator("#window-controls")
      .evaluate((element) => (element as HTMLElement).style.zoom),
  ).toBe("");
  console.log(
    `Zoom checks passed (${signedOut ? "signed out" : "signed in"}). Screenshots: ${path.resolve(config.artifactDir)}`,
  );
} finally {
  await setZoom(originalZoom ?? 1);
  if (layoutChanged) {
    await mcp.call("vortex_dispatch", {
      action: "type:SET_USE_MODERN_LAYOUT",
      args: [originalLayout],
    });
    await page.reload();
    await mcp.waitUntilReady();
  }
  if (originalViewport.window) await mcp.call("ui_set_viewport", originalViewport.window);
  await handle.close();
  await ownedInstance?.stop();
}
