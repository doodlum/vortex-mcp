/** Live regression for page-per-panel layouts in a running Bethesda sandbox. */
import fs from "node:fs";
import { expect } from "@playwright/test";
import { attachToRenderer, captureScreenshot } from "../cdp";
import { loadConfig } from "../config";
import { claimInstanceLease } from "../instance";
import { VortexMcpClient } from "../mcpClient";
import { clickByName } from "../uiDriver";

interface Workspace {
  root: unknown;
  panels: Record<string, { id: string; pageId: string }>;
  focusedPanel: string;
  nextId: number;
  recent: string[];
}
const config = loadConfig();
claimInstanceLease(config, "panel-only regression", {}, { attach: true });
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
expect(await mcp.call("vortex_query", { selector: "activeGameId" })).toBe("fallout4");
const handle = await attachToRenderer(config);
const page = handle.page;
const button = (name: string) => page.getByRole("button", { name, exact: true });
const click = (name: string) => clickByName(mcp, { role: "button", name });
const addPanel = () => click("Add panel");
const assertRightToolbar = async () => {
  const titlebar = page.locator("[data-app-titlebar]");
  const add = await button("Add panel").boundingBox();
  const menu = await button("Choose panel position").boundingBox();
  const profile = await titlebar.locator('[data-testid="profile-menu-trigger"]').boundingBox();
  const premiumGroup = titlebar.locator("[data-header-premium-group]");
  const premium = await premiumGroup.locator('[data-testid="premium-indicator"]').boundingBox();
  const separators = await premiumGroup.locator('span[aria-hidden="true"]').all();
  const premiumDivider = await separators[0]?.boundingBox();
  const version = await titlebar.locator('[data-testid="version-indicator"]').boundingBox();
  const windowDivider = await titlebar.locator("[data-header-window-divider]").boundingBox();
  const minimize = await titlebar.getByRole("button", { name: "Minimize" }).boundingBox();
  if (
    !add ||
    !menu ||
    !profile ||
    !premium ||
    !premiumDivider ||
    !version ||
    !windowDivider ||
    !minimize
  )
    throw new Error("Top-bar controls are not visible");
  const width = await page.evaluate(() => window.innerWidth);
  expect(add.x).toBeGreaterThan(width * 0.65);
  expect(Math.abs(add.x + add.width - menu.x)).toBeLessThan(2);
  expect(add.height).toBe(profile.height);
  expect(menu.height).toBe(profile.height);
  expect(add.width).toBe(28);
  expect(menu.width).toBe(18);
  expect(profile.width).toBe(add.width + menu.width);
  expect(profile.x).toBeGreaterThanOrEqual(menu.x + menu.width);
  expect(separators).toHaveLength(1);
  expect(premium.x).toBeGreaterThan(profile.x + profile.width);
  expect(premiumDivider.x).toBeGreaterThan(premium.x + premium.width);
  expect(version.x).toBeGreaterThan(premiumDivider.x + premiumDivider.width);
  expect(windowDivider.x).toBeGreaterThan(version.x + version.width);
  expect(minimize.x).toBeGreaterThan(windowDivider.x + windowDivider.width);
  expect(Math.abs(premium.y - version.y)).toBeLessThan(1);
  expect(premium.height).toBe(version.height);
  expect(Math.abs(windowDivider.y - premiumDivider.y)).toBeLessThan(1);
  expect(
    await titlebar.locator('[data-testid="profile-menu-trigger"]').getAttribute("aria-haspopup"),
  ).toBe("menu");
};
const assertCloseCornerSpacing = async (panelName: string, closeName: string) => {
  const frame = await page.getByRole("region", { name: panelName, exact: true }).boundingBox();
  const close = await button(closeName).boundingBox();
  if (!frame || !close) throw new Error(`Cannot measure ${panelName} close control`);
  const rightGap = frame.x + frame.width - close.x - close.width;
  expect(rightGap).toBeGreaterThan(10);
  expect(rightGap).toBeLessThan(17);
  const header = page
    .getByRole("region", { name: panelName, exact: true })
    .locator("[data-panel-header-actions], [data-panel-plain-header-actions]");
  await expect(header.locator('span[aria-hidden="true"]')).toHaveCount(0);
};
const assertModernCloseCorner = async (panelName: string, closeName: string) => {
  const header = page
    .getByRole("region", { name: panelName, exact: true })
    .locator("[data-page-header]");
  await expect(header).toBeVisible();
  await expect(button(closeName)).toBeVisible();
  const headerBounds = await header.boundingBox();
  const closeBounds = await button(closeName).boundingBox();
  if (!headerBounds || !closeBounds) throw new Error(`Cannot measure ${panelName} modern header`);
  expect(Math.abs(closeBounds.y - headerBounds.y - 12)).toBeLessThan(0.5);
  expect(
    Math.abs(headerBounds.x + headerBounds.width - closeBounds.x - closeBounds.width - 12),
  ).toBeLessThan(0.5);
};
const assertWrappedModernToolbar = async (panelName: string, closeName: string) => {
  const header = page
    .getByRole("region", { name: panelName, exact: true })
    .locator("[data-page-header]");
  const toolbar = header.locator("[data-page-header-toolbar]");
  await expect(toolbar).toBeVisible();
  await expect(header.locator("[data-panel-header-divider]")).toHaveCount(0);
  const contentBounds = await header.locator(".max-w-8xl").boundingBox();
  const toolbarBounds = await toolbar.boundingBox();
  const closeBounds = await button(closeName).boundingBox();
  if (!contentBounds || !toolbarBounds || !closeBounds)
    throw new Error(`Cannot measure ${panelName} wrapped toolbar`);
  expect(toolbarBounds.y).toBeGreaterThanOrEqual(closeBounds.y + closeBounds.height);
  expect(
    Math.abs(contentBounds.x + contentBounds.width - toolbarBounds.x - toolbarBounds.width - 24),
  ).toBeLessThan(1);
};
const panels = page.locator("[data-panel-id]");
const saved = (scope: string) =>
  mcp.call<Workspace>("vortex_query", {
    path: ["settings", "panels", "layouts", scope, "__workspace"],
  });
const setWorkspace = (scope: string, workspace: Workspace) =>
  mcp.call("vortex_dispatch", {
    action: "type:SET_PANEL_WORKSPACE",
    args: [{ scope, layoutKey: "__workspace", workspace }],
  });
const selectPage = (pageId: string) =>
  mcp.call("vortex_dispatch", { action: "setOpenMainPage", args: [pageId, false] });
const choose = async (id: string) => {
  const choice = page.locator(`[data-panel-choice="${id}"]`).last();
  await expect(choice).toBeVisible();
  await choice.click();
};
const capture = (label: string) => captureScreenshot(config, { label, handle }).then(console.log);
const onePanel = (pageId: string): Workspace => ({
  root: { kind: "panel", id: "panel-1" },
  panels: { "panel-1": { id: "panel-1", pageId } },
  focusedPanel: "panel-1",
  nextId: 2,
  recent: [pageId],
});
const originalViewport = page.viewportSize();
let originalGame: Workspace | undefined;
let originalHome: Workspace | undefined;
let originalCompact: boolean | undefined;
try {
  await click("Fallout 4");
  await expect(button("Add panel")).toBeVisible({ timeout: 30000 });
  originalGame = await saved("fallout4");
  originalCompact = await mcp.call<boolean>("vortex_query", {
    path: ["settings", "interface", "alwaysCompactHeaders"],
  });
  expect(originalGame.panels[originalGame.focusedPanel]?.pageId).toBeTruthy();
  if (process.argv.includes("--verify-saved")) {
    const expected = JSON.parse(
      fs.readFileSync("harness/.artifacts/panels-expected-after-restart.json", "utf8"),
    ) as Workspace;
    expect(originalGame).toEqual(expected);
    await expect(panels).toHaveCount(Object.keys(expected.panels).length);
    await expect(page.locator("[data-panel-tabbar], [data-panel-new-tab]")).toHaveCount(0);
    console.log("Saved page-per-panel layout survived a clean Vortex restart.");
  } else {
    await mcp.call("ui_set_viewport", { width: 1920, height: 1080 });
    await assertRightToolbar();
    await mcp.call("ui_set_viewport", { width: 960, height: 720 });
    await assertRightToolbar();
    await mcp.call("ui_set_viewport", { width: 1920, height: 1080 });
    const profileLabel = await page
      .locator('[data-testid="profile-menu-trigger"]')
      .getAttribute("aria-label");
    if (!profileLabel) throw new Error("The profile menu has no accessible label");
    await click(profileLabel);
    await expect(page.getByRole("menuitem", { name: "View profile on web" })).toBeVisible();
    await capture("titlebar-profile-menu");
    await page.keyboard.press("Escape");
    if (await button("Open menu").count()) await click("Open menu");
    await setWorkspace("fallout4", onePanel("Mods"));
    await selectPage("Mods");
    await expect(page.getByRole("region", { name: "Mods panel", exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Mods panel", exact: true }).locator("[data-panel-outline]"),
    ).toHaveCSS("border-top", "2px solid rgb(82, 82, 91)");
    await expect(panels).toHaveCount(1);
    await expect(page.locator("[data-panel-tabbar], [data-panel-new-tab]")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Mods", exact: true })).toHaveCount(0);
    await expect(button("Add panel")).toHaveAttribute("data-panel-next-position", "right");
    await click("Choose panel position");
    await expect(page.getByRole("menuitem", { name: "Right column" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /panel tabs/i })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await addPanel();
    await expect(panels).toHaveCount(2);
    const chooser = page.locator('[data-panel-chooser="panel"]');
    await expect(chooser).toBeVisible();
    await expect(chooser.locator("[data-panel-choice]").first()).toBeFocused();
    await expect(chooser.locator('[data-panel-choice="Mods"]')).toHaveCount(0);
    await expect(chooser.locator('[data-panel-choice="Dashboard"]')).toHaveCount(0);
    await expect(chooser.getByRole("textbox")).toHaveCount(0);
    await expect(button("Close new panel")).toHaveCount(1);
    await assertCloseCornerSpacing("Mods panel", "Close Mods panel");
    await assertModernCloseCorner("Mods panel", "Close Mods panel");
    await assertCloseCornerSpacing("New panel panel", "Close new panel");
    await expect(page.getByRole("button", { name: /new tab/i })).toHaveCount(0);
    await choose("gamebryo-plugins");
    await expect(page.getByRole("region", { name: "Plugins panel", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Mods panel", exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Plugins panel", exact: true })
        .locator("[data-panel-outline]"),
    ).toHaveCSS("border-top", "2px solid rgb(82, 82, 91)");
    await expect(
      page.getByRole("region", { name: "Mods panel", exact: true }).locator("[data-panel-outline]"),
    ).toHaveCSS("border-top", "1px solid rgb(29, 29, 33)");
    await mcp.call("vortex_dispatch", {
      action: "type:SET_ALWAYS_COMPACT_HEADERS",
      args: [true],
    });
    try {
      const modernTitle = page.locator("#page-Mods h2");
      const modernHeader = modernTitle.locator('xpath=ancestor::div[contains(@class, "py-3")][1]');
      const legacyHeader = page.locator("[data-panel-plain-actions]");
      const legacyTitle = legacyHeader.locator("h2");
      await expect(modernHeader).toHaveCSS("height", "53px");
      await assertModernCloseCorner("Mods panel", "Close Mods panel");
      await expect(
        page
          .getByRole("region", { name: "Mods panel", exact: true })
          .locator("[data-panel-header-divider]"),
      ).toHaveCount(0);
      await expect(legacyHeader).toHaveCSS("height", "53px");
      await expect(legacyHeader).toHaveCSS("background-color", "rgb(29, 29, 33)");
      await expect(legacyTitle).toHaveCSS("font-size", "18px");
      await expect(legacyTitle).toHaveCSS("color", "rgb(161, 161, 170)");
      await expect(legacyHeader.locator("svg").first()).toHaveCSS("width", "28px");
      await expect(page.locator("#page-gamebryo-plugins .panel > .panel-body")).toHaveCSS(
        "background-color",
        "rgb(29, 29, 33)",
      );
      await expect(page.locator("#page-gamebryo-plugins .mainpage-header-container")).toHaveCSS(
        "background-color",
        "rgb(41, 41, 46)",
      );
      const modernBounds = await modernHeader.boundingBox();
      const legacyBounds = await legacyHeader.boundingBox();
      const modernClose = await button("Close Mods panel").boundingBox();
      const legacyClose = await button("Close Plugins panel").boundingBox();
      if (!modernBounds || !legacyBounds || !modernClose || !legacyClose)
        throw new Error("Compact headers are unavailable");
      expect(Math.abs(modernBounds.y - legacyBounds.y)).toBeLessThan(0.5);
      expect(Math.abs(modernBounds.height - legacyBounds.height)).toBeLessThan(0.5);
      expect(Math.abs(modernClose.y - legacyClose.y)).toBeLessThan(0.5);
      await capture("panels-compact-legacy-header");
    } finally {
      await mcp.call("vortex_dispatch", {
        action: "type:SET_ALWAYS_COMPACT_HEADERS",
        args: [originalCompact],
      });
    }
    await mcp.call("ui_set_viewport", { width: 1280, height: 720 });
    await expect(page.locator("#page-Mods h2").getByText("Mods")).toBeVisible();
    await capture("panels-no-tabs-narrow-two");
    await mcp.call("ui_set_viewport", { width: 1920, height: 1080 });
    const modsButton = page.locator('[data-panel-sidebar-page="Mods"] button[aria-label="Mods"]');
    const pluginsButton = page.locator(
      '[data-panel-sidebar-page="gamebryo-plugins"] button[aria-label="Plugins"]',
    );
    await expect(modsButton).toHaveClass(/bg-surface-low/);
    await expect(pluginsButton).toHaveClass(/bg-surface-low/);
    await expect(pluginsButton).toHaveClass(/ring-2/);
    await expect(pluginsButton).toHaveClass(/ring-neutral-600/);
    const pluginsSortButton = page.locator("#page-gamebryo-plugins .mainpage-header #btn-sort");
    await expect(pluginsSortButton).toBeVisible();
    const modsBoundsBefore = await page.locator("#page-Mods").boundingBox();
    await page.locator("#page-Mods h2").click();
    await expect(modsButton).toHaveClass(/ring-2/);
    await expect(pluginsButton).not.toHaveClass(/ring-2/);
    await expect(pluginsSortButton).toBeVisible();
    const modsBoundsAfter = await page.locator("#page-Mods").boundingBox();
    if (!modsBoundsBefore || !modsBoundsAfter) throw new Error("Mods page bounds are unavailable");
    for (const key of ["x", "y", "width", "height"] as const)
      expect(Math.abs(modsBoundsBefore[key] - modsBoundsAfter[key])).toBeLessThan(0.5);
    await click("Health check");
    await expect(
      page.getByRole("region", { name: "Health check panel", exact: true }),
    ).toBeVisible();
    await assertModernCloseCorner("Health check panel", "Close Health check panel");
    await assertWrappedModernToolbar("Health check panel", "Close Health check panel");
    await mcp.call("ui_set_viewport", { width: 1280, height: 720 });
    await assertModernCloseCorner("Health check panel", "Close Health check panel");
    await assertWrappedModernToolbar("Health check panel", "Close Health check panel");
    await mcp.call("ui_set_viewport", { width: 1920, height: 1080 });
    const healthWorkspace = await saved("fallout4");
    await setWorkspace("fallout4", onePanel("Health check"));
    await expect(panels).toHaveCount(1);
    await expect(button("Close Health check panel")).toHaveCount(0);
    const singleHeader = page
      .getByRole("region", { name: "Health check panel", exact: true })
      .locator("[data-page-header]");
    const singleContentBounds = await singleHeader.locator(".max-w-8xl").boundingBox();
    const singleToolbarBounds = await singleHeader
      .locator("[data-page-header-toolbar]")
      .boundingBox();
    if (!singleContentBounds || !singleToolbarBounds)
      throw new Error("Cannot measure the single-panel Health check toolbar");
    expect(
      Math.abs(
        singleContentBounds.x +
          singleContentBounds.width -
          singleToolbarBounds.x -
          singleToolbarBounds.width -
          24,
      ),
    ).toBeLessThan(1);
    await setWorkspace("fallout4", healthWorkspace);
    await expect(panels).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Plugins panel", exact: true })).toBeVisible();
    expect(Object.values((await saved("fallout4")).panels).map((panel) => panel.pageId)).toEqual([
      "Health check",
      "gamebryo-plugins",
    ]);
    await pluginsButton.click();
    await expect(pluginsButton).toHaveClass(/ring-2/);
    await expect(page.getByRole("region", { name: "Plugins panel", exact: true })).toHaveAttribute(
      "data-panel-focused",
      "true",
    );
    const separator = page.getByRole("separator", { name: "Resize panel columns" });
    await separator.focus();
    await separator.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "45");
    await separator.dblclick();
    await expect(separator).toHaveAttribute("aria-valuenow", "50");
    await addPanel();
    await choose("gamebryo-savegames");
    await expect(panels).toHaveCount(3);
    await expect(page.locator("#page-gamebryo-savegames .panel > .panel-body")).toHaveCSS(
      "background-color",
      "rgb(29, 29, 33)",
    );
    await addPanel();
    await choose("tools_page");
    await expect(panels).toHaveCount(4);
    await assertModernCloseCorner("Tools panel", "Close Tools panel");
    await expect(button("Add panel")).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("[data-panel-tabbar], [data-panel-new-tab]")).toHaveCount(0);
    await capture("panels-no-tabs-four");
    await click("Close Tools panel");
    await expect(panels).toHaveCount(3);
    await click("Game settings");
    await assertModernCloseCorner("Game settings panel", "Close Game settings panel");

    await click("Home");
    originalHome = await saved("__home");
    await setWorkspace("__home", onePanel("Dashboard"));
    await selectPage("Dashboard");
    await addPanel();
    const homeChoices = await page
      .locator("[data-panel-choice]")
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-panel-choice")));
    expect(homeChoices).toContain("Games");
    expect(homeChoices).toContain("Extensions");
    expect(homeChoices).not.toContain("Mods");
    await choose("Games");
    await expect(page.getByRole("region", { name: "Games panel", exact: true })).toBeVisible();
    await click("Extensions");
    await expect(page.getByRole("region", { name: "Extensions panel", exact: true })).toBeVisible();
    await assertModernCloseCorner("Extensions panel", "Close Extensions panel");
    expect(Object.values((await saved("__home")).panels).map((panel) => panel.pageId)).toEqual([
      "Dashboard",
      "Extensions",
    ]);
    await capture("panels-no-tabs-home");
    console.log(
      "Panel-only navigation, placement, resize, Home scope, and four-panel limit passed.",
    );
  }
} finally {
  if (originalCompact !== undefined)
    await mcp.call("vortex_dispatch", {
      action: "type:SET_ALWAYS_COMPACT_HEADERS",
      args: [originalCompact],
    });
  if (originalHome) await setWorkspace("__home", originalHome);
  await click("Fallout 4");
  if (originalGame) {
    await setWorkspace("fallout4", originalGame);
    await selectPage(originalGame.panels[originalGame.focusedPanel]?.pageId ?? "Mods");
    if (!process.argv.includes("--verify-saved"))
      fs.writeFileSync(
        "harness/.artifacts/panels-expected-after-restart.json",
        JSON.stringify(originalGame),
      );
  }
  if (originalViewport) await mcp.call("ui_set_viewport", originalViewport);
  await handle.close();
}
