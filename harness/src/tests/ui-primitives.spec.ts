import fs from "node:fs";
import path from "node:path";
import { captureScreenshot, realHover } from "../cdp";
import { clickByName, fillByName, snapshot, flatten, waitForNode } from "../uiDriver";
import { expect, test } from "./fixtures";
import { runResponsiveSweep } from "../responsive";

test("records screenshots and layout evidence for independent width and height changes", async ({
  config,
  mcp,
  vortexWindow,
}) => {
  await clickByName(mcp, { role: "button", name: "Home" });
  await waitForNode(mcp, { role: "button", name: "Settings" });
  await clickByName(mcp, { role: "button", name: "Settings" });
  await expect(vortexWindow.getByRole("heading", { name: /settings/i }).first()).toBeVisible();
  const report = await runResponsiveSweep(mcp, config, {
    screenshots: true,
    label: "settings-review",
    viewports: [
      { width: 1280, height: 720 },
      { width: 1280, height: 1000 },
      { width: 1600, height: 1000 },
    ],
  });
  expect(report.results).toHaveLength(3);
  expect(report.results[1]!.inner.height).toBeGreaterThan(report.results[0]!.inner.height);
  expect(report.results[2]!.inner.width).toBeGreaterThan(report.results[1]!.inner.width);
  expect(fs.existsSync(report.reportFile!)).toBe(true);
  for (const screenshot of report.screenshots)
    expect(fs.statSync(screenshot).size).toBeGreaterThan(10_000);
});

test("profile and debug ports belong to the isolated test instance", async ({
  config,
  mcp,
  vortexApp,
}) => {
  // Electron can replace its initial execution context during startup.
  await expect(async () => {
    const actual = await vortexApp.evaluate(({ app }) => app.getPath("userData"));
    expect(path.resolve(actual)).toBe(path.join(config.cacheDir, "instance", "userData"));
  }).toPass({ timeout: 10_000 });
  expect(await mcp.call("nexus_auth_status")).toEqual({
    apiKeyPresent: false,
    oauthPresent: false,
    oauthRefreshable: false,
  });
});

test("React game search responds to fill, including clearing the input", async ({
  mcp,
  vortexWindow,
}) => {
  await mcp.call("ui_click", { selector: 'button[aria-label="Games"]' });
  await waitForNode(mcp, { role: "textbox", name: /search/i });
  await fillByName(mcp, { role: "textbox", name: /search/i }, "Fallout 4");
  await expect(vortexWindow.locator('img[alt="Fallout 4"]')).toBeVisible();
  await expect(vortexWindow.locator('img[alt="Skyrim Special Edition"]')).toHaveCount(0);
  await fillByName(mcp, { role: "textbox", name: /search/i }, "no-game-matches-this-string");
  await expect(vortexWindow.locator('img[alt="Fallout 4"]')).toHaveCount(0);
  await fillByName(mcp, { role: "textbox", name: /search/i }, "");
});

test("browser events, native selects, scrolling, waits and CSS hover work through their documented paths", async ({
  mcp,
  config,
  vortexWindow,
}) => {
  await vortexWindow.evaluate(() => {
    const panel = document.createElement("section");
    panel.id = "automation-probe";
    panel.style.cssText =
      "position:fixed;top:180px;left:450px;width:340px;z-index:99999;background:white;color:black;padding:20px";
    panel.innerHTML =
      '<style>#probe-hover span{opacity:0}#probe-hover:hover span{opacity:1}</style><input id="probe-text" aria-label="Probe text"><select id="probe-select"><option value="a">Alpha</option><option value="b">Beta</option></select><div id="probe-scroll" style="overflow:auto;height:60px"><div style="height:600px">Scrollable content</div></div><button id="probe-hover">Hover <span>revealed</span></button>';
    document.body.append(panel);
    panel.querySelector("input")!.addEventListener("keydown", (event) => {
      panel.dataset.key = (event as KeyboardEvent).key;
    });
    panel.querySelector("select")!.addEventListener("change", () => {
      panel.dataset.changed = "yes";
    });
    panel.querySelector("#probe-scroll")!.addEventListener("scroll", () => {
      panel.dataset.scrolled = "yes";
    });
    panel.querySelector("button")!.addEventListener("mouseover", () => {
      panel.dataset.hovered = "yes";
    });
  });
  try {
    await mcp.call("ui_fill", { selector: "#probe-text", value: "typed through MCP" });
    await expect(vortexWindow.locator("#probe-text")).toHaveValue("typed through MCP");
    await mcp.call("ui_press_key", { selector: "#probe-text", key: "Enter" });
    await expect(vortexWindow.locator("#automation-probe")).toHaveAttribute("data-key", "Enter");
    await mcp.call("ui_select_option", { selector: "#probe-select", label: "Beta" });
    await expect(vortexWindow.locator("#probe-select")).toHaveValue("b");
    await expect(vortexWindow.locator("#automation-probe")).toHaveAttribute("data-changed", "yes");
    await mcp.call("ui_scroll", { selector: "#probe-scroll", deltaY: 200 });
    expect(await vortexWindow.locator("#probe-scroll").evaluate((el) => el.scrollTop)).toBe(200);
    await expect(vortexWindow.locator("#automation-probe")).toHaveAttribute("data-scrolled", "yes");
    await vortexWindow.mouse.move(0, 0);
    await mcp.call("ui_hover", { selector: "#probe-hover" });
    await expect(vortexWindow.locator("#automation-probe")).toHaveAttribute("data-hovered", "yes");
    await expect(vortexWindow.locator("#probe-hover span")).toHaveCSS("opacity", "0");
    await realHover(config, "#probe-hover");
    await expect(vortexWindow.locator("#probe-hover span")).toHaveCSS("opacity", "1");
    expect(
      await mcp.call("ui_wait_for", { selector: "#probe-text", state: "visible" }),
    ).toMatchObject({ matched: true });
    expect(
      await mcp.call("ui_wait_for", { selector: "#no-such-probe", timeoutMs: 100 }),
    ).toMatchObject({ matched: false });
  } finally {
    await vortexWindow.locator("#automation-probe").evaluate((el) => el.remove());
  }
});

test("screenshots contain a real PNG and leave the app connected", async ({
  config,
  mcp,
}, testInfo) => {
  const file = await captureScreenshot(config, { label: "ui-suite" });
  expect(fs.readFileSync(file).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(fs.statSync(file).size).toBeGreaterThan(10_000);
  await testInfo.attach("Vortex screenshot", { path: file, contentType: "image/png" });
  expect(await mcp.ping()).toBe(true);
});

test("renderer reload completes and invalidates earlier references", async ({
  mcp,
  vortexWindow,
}) => {
  const old = await mcp.call<{ runtimeId: string }>("automation_status");
  const ref = flatten((await snapshot(mcp)).tree)[0]!.ref;
  await mcp.call("ui_reload_renderer");
  await expect
    .poll(
      async () =>
        (await mcp.call<{ runtimeId: string }>("automation_status").catch(() => old)).runtimeId,
      { timeout: 60_000 },
    )
    .not.toBe(old.runtimeId);
  await snapshot(mcp);
  await expect(mcp.call("ui_click", { ref })).rejects.toThrow(/stale or unknown ref/i);
  await expect(vortexWindow.locator("body")).toBeVisible();
});
