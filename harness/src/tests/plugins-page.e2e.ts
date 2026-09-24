/**
 * Opt-in responsiveness check of the Plugins page with a large load order:
 * pnpm run ai:test:plugins-page (fake Fallout 4: `up --dev-dir <checkout> --bethesda-sandbox`).
 *
 * Users with large collections on 2.7 reported "constantly freezes scrolling through mods or
 * plugins". The plugin list's own table is virtualised; this measures what the page costs
 * with thousands of plugins, doing what a user does there — scroll, filter, toggle a plugin —
 * and records renderer blocking for each, plus how many plugin rows are rendered in full.
 *
 *   --plugins <n>   mods with one plugin each (default 2000)
 */
import fs from "node:fs";
import path from "node:path";

import { attachToRenderer } from "../cdp";
import { bethesdaSandboxPaths, pluginBytes } from "../bethesdaSandbox";
import { loadConfig } from "../config";
import { claimInstanceLease } from "../instance";
import { deployMods } from "../deployment";
import { fillFilterScript, measureBlocked, seedLibrary, tableRows } from "../largeLibrary";
import { VortexMcpClient } from "../mcpClient";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const count = Number(flag("plugins") ?? 2000);
const TABLE = "gamebryo-plugins";
/** Budgets: the page should stay interactive. */
const MAX_ROWS_RENDERED = 200;
const MAX_ACTION_BLOCKED_MS = 1_500;

const config = loadConfig();
// Drives the running instance: refuse while another owner holds it.
claimInstanceLease(config, "ai:test:plugins-page");
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
const status = await mcp.call<{ paths?: { documents: string | null } }>("automation_status");
if (
  (await mcp.call<string | null>("vortex_query", { selector: "activeGameId" })) !== "fallout4" ||
  path.resolve(status.paths?.documents ?? "").toLowerCase() !==
    path.resolve(bethesdaSandboxPaths(config.cacheDir).documents).toLowerCase()
) {
  throw new Error(
    "This check needs the fake Fallout 4: `vortex-ai up --dev-dir <checkout> --bethesda-sandbox`.",
  );
}

await seedLibrary(mcp, {
  count,
  filesPerMod: 1,
  plugin: (modId) => ({
    name: `${modId}.esp`,
    bytes: pluginBytes({ name: `${modId}.esp`, masters: ["Fallout4.esm"] }),
  }),
});
await deployMods(mcp, "fallout4", { timeoutMs: 60 * 60 * 1000 });

const handle = await attachToRenderer(config);
const { page } = handle;
await mcp.call("vortex_dispatch", { action: "setOpenMainPage", args: ["gamebryo-plugins", false] });
await page.waitForSelector(`#table-${TABLE} tr[data-rowid]`, { timeout: 120_000 });
await page.waitForTimeout(5_000);

const result: Record<string, unknown> = { plugins: count };
const failures: string[] = [];
const budget = (what: string, blocked: { blockedMs: number; longestMs: number }): void => {
  if (blocked.longestMs > MAX_ACTION_BLOCKED_MS) {
    failures.push(
      `${what} froze the UI for ${String(blocked.longestMs)}ms (allowed ${String(MAX_ACTION_BLOCKED_MS)})`,
    );
  }
};

const rows = await tableRows(page, TABLE);
result.rows = rows;
if (rows.rendered > MAX_ROWS_RENDERED) {
  failures.push(
    `${String(rows.rendered)} plugin rows rendered in full with ${String(rows.onScreen)} on screen`,
  );
}

// Scroll through the list in steps, as a user dragging the scrollbar does.
result.scroll = await measureBlocked(
  page,
  `
  const pane = document.querySelector("#table-${TABLE} .table-main-pane");
  let node = pane;
  while (node && !(node.scrollHeight > node.clientHeight &&
    ["auto", "scroll"].includes(getComputedStyle(node).overflowY))) node = node.parentElement;
  for (let step = 1; step <= 10; step++) {
    node.scrollTop = (node.scrollHeight - node.clientHeight) * step / 10;
    node.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 150));
  }
  node.scrollTop = 0;
  node.dispatchEvent(new Event("scroll"));
  `,
);
budget("scrolling the plugin list", result.scroll as { blockedMs: number; longestMs: number });

result.filter = await measureBlocked(page, fillFilterScript(TABLE, "library-00001"));
result.clear = await measureBlocked(page, fillFilterScript(TABLE, ""));
budget("clearing the plugin filter", result.clear as { blockedMs: number; longestMs: number });

// Toggle the first visible plugin off and on through its own control, as a click does,
// recording what the row shows after each: the table must still reflect the change.
const firstRowState = `document.querySelector("#table-${TABLE} tr[data-rowid] .cell-enabled button.dropdown-title")?.textContent?.trim()`;
const before = await page.evaluate(firstRowState);
result.toggle = await measureBlocked(
  page,
  `
  const toggle = () => {
    const row = document.querySelector("#table-${TABLE} tr[data-rowid]");
    // the Enabled/Disabled split button; its title half toggles the plugin
    const control = row && row.querySelector(".cell-enabled button.dropdown-title");
    if (!control) throw new Error("no enable control in the first plugin row");
    control.click();
  };
  toggle();
  await new Promise((r) => setTimeout(r, 1500));
  window.__pluginsPageAfterFirstToggle = ${firstRowState};
  toggle();
  `,
  2_000,
);
const afterFirst = await page.evaluate("window.__pluginsPageAfterFirstToggle");
const afterSecond = await page.evaluate(firstRowState);
result.toggleStates = { before, afterFirst, afterSecond };
if (before === afterFirst || afterSecond !== before) {
  failures.push(
    `the plugin row did not follow its toggles (before ${String(before)}, after one ` +
      `${String(afterFirst)}, after two ${String(afterSecond)})`,
  );
}
budget("toggling a plugin", result.toggle as { blockedMs: number; longestMs: number });

await handle.close();
result.failures = failures;
fs.mkdirSync(config.artifactDir, { recursive: true });
const report = path.join(config.artifactDir, `plugins-page-${String(Date.now())}.json`);
fs.writeFileSync(report, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(`evidence: ${report}`);
if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
