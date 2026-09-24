/**
 * Opt-in performance check against a running instance: pnpm run ai:test:large-library.
 *
 * Seeds a library of several thousand small mods (see largeLibrary.ts) and checks the
 * what users with large collections reported as broken on Vortex 2.7:
 *
 * - the Mods table renders only the rows near the screen, not every mod;
 * - clearing a name filter doesn't lock the UI up for seconds;
 * - scrolling to any depth shows rendered rows, never blank placeholders;
 * - installing mods one after another, as a collection does, doesn't freeze the UI;
 * - deploying with the Mods page open costs about what it costs from another page.
 *
 * These fail on a stock 2.7.0, where the Mods page's sticky header leaves the
 * table's rows observed against a pane that no longer clips, so every row renders in
 * full. That is why this is opt-in rather than part of `ai:test`, which has to pass
 * against released Vortex. It needs no account; use the sandbox game, because it
 * deploys and purges.
 *
 *   --mods <n>      library size (default 3000)
 *   --layout <l>    modern | classic (default modern, which is Vortex's default)
 *   --installs <n>  local installs to time (default 10; 0 skips)
 *   --no-deploy     skip the deploy comparison, which takes a few minutes
 */
import fs from "node:fs";
import path from "node:path";

import { strToU8, zipSync } from "fflate";

import { attachToRenderer, captureScreenshot } from "../cdp";
import { loadConfig } from "../config";
import { claimInstanceLease } from "../instance";
import { purgeGame } from "../deployment";
import {
  fillFilterScript,
  measureBlocked,
  seedLibrary,
  tableRows,
  timeDeploy,
} from "../largeLibrary";
import { installLocalMod } from "../localMod";
import { VortexMcpClient } from "../mcpClient";
import { markLog, readSince, summariseLog } from "../vortexLog";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const count = Number(flag("mods") ?? 3000);
const layout = flag("layout") ?? "modern";
const deploy = !process.argv.includes("--no-deploy");
const installs = Number(flag("installs") ?? 10);

/** Rendered rows allowed: a screenful plus the observer's 360px margins, generously. */
const MAX_RENDERED_ROWS = 200;
/** How long clearing the filter may block the renderer. 2.6 took well under a second. */
const MAX_CLEAR_BLOCKED_MS = 2_000;
/** Deploying from the Mods page may cost this much more than from Settings. */
const MAX_DEPLOY_RATIO = 1.6;
/** Longest single main-thread task allowed while mods install. */
const MAX_INSTALL_FREEZE_MS = 1_500;

const config = loadConfig();
// Drives the running instance: refuse while another owner holds it.
claimInstanceLease(config, "ai:test:large-library");
const mcp = new VortexMcpClient({ port: config.mcpPort, token: config.mcpToken });
await mcp.waitUntilReady();
const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
if (gameId !== "vortexaisandbox") {
  throw new Error(
    `This check deploys and purges, so it runs only on the sandbox game (active: ${String(gameId)}). ` +
      "Start the instance with `vortex-ai up --sandbox`.",
  );
}
const originalLayout = await mcp.call<boolean>("vortex_query", {
  path: ["settings", "window", "useModernLayout"],
});
// Installs trigger Vortex's own auto-deploy, which then races the check's purge and
// leaves files behind. Off for the run; restored afterwards.
const originalAutoDeploy = await mcp.call<boolean>("vortex_query", {
  path: ["settings", "automation", "deploy"],
});
await mcp.call("vortex_dispatch", { action: "setAutoDeployment", args: [false] });
const handle = await attachToRenderer(config);
const { page } = handle;
const failures: string[] = [];
const result: Record<string, unknown> = { count, layout };

const openPage = async (id: string): Promise<void> => {
  await mcp.call("vortex_dispatch", { action: "setOpenMainPage", args: [id, false] });
  await page.waitForTimeout(3_000);
};

try {
  await mcp.call("vortex_dispatch", { action: "setUseModernLayout", args: [layout === "modern"] });
  await page.waitForTimeout(3_000);
  const library = await seedLibrary(mcp, { count });
  result.modIds = library.modIds.length;

  await openPage("Mods");
  await page.waitForSelector("#table-mods tr[data-rowid]", { timeout: 60_000 });
  await page.waitForTimeout(5_000);

  const rows = await tableRows(page, "mods");
  result.rows = rows;
  if (rows.total < count) failures.push(`only ${String(rows.total)} of ${String(count)} rows`);
  if (rows.rendered > MAX_RENDERED_ROWS) {
    failures.push(
      `${String(rows.rendered)} rows rendered in full with ${String(rows.onScreen)} on screen ` +
        `(allowed ${String(MAX_RENDERED_ROWS)}) — the table is not virtualising`,
    );
  }

  result.filter = await measureBlocked(page, fillFilterScript("mods", "Mod 0001"));
  const cleared = await measureBlocked(page, fillFilterScript("mods", ""));
  result.clear = cleared;
  result.rowsAfterClear = await tableRows(page, "mods");
  if (cleared.blockedMs > MAX_CLEAR_BLOCKED_MS) {
    failures.push(
      `clearing the filter blocked the UI for ${String(cleared.blockedMs)}ms ` +
        `(allowed ${String(MAX_CLEAR_BLOCKED_MS)})`,
    );
  }
  await captureScreenshot(config, { label: `large-library-${layout}`, handle });

  // Rendering fewer rows is only a fix if the ones scrolled to still render: scroll
  // whatever scrolls the table to several depths and require every row on screen to
  // have its cells rather than be a blank placeholder.
  const scrolled: Array<{ at: number; placeholdersOnScreen: number; renderedOnScreen: number }> =
    [];
  for (const at of [0.25, 0.5, 0.9, 0]) {
    await page.evaluate(`(() => {
      const pane = document.querySelector("#table-mods .table-main-pane");
      let node = pane;
      while (node && !(node.scrollHeight > node.clientHeight &&
        ["auto", "scroll"].includes(getComputedStyle(node).overflowY))) node = node.parentElement;
      node.scrollTop = (node.scrollHeight - node.clientHeight) * ${String(at)};
    })()`);
    await page.waitForTimeout(1_500);
    const onScreen = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll("#table-mods tr[data-rowid]"));
      const visible = rows.filter((row) => {
        const box = row.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      });
      return {
        placeholders: visible.filter((row) => row.children.length <= 1).length,
        rendered: visible.filter((row) => row.children.length > 1).length,
      };
    })()`);
    const sample = onScreen as { placeholders: number; rendered: number };
    scrolled.push({
      at,
      placeholdersOnScreen: sample.placeholders,
      renderedOnScreen: sample.rendered,
    });
    if (sample.placeholders > 0 || sample.rendered === 0) {
      failures.push(
        `scrolled ${String(at * 100)}% down: ${String(sample.placeholders)} blank rows on ` +
          `screen, ${String(sample.rendered)} rendered`,
      );
    }
  }
  result.scrolled = scrolled;
  result.rowsAfterScroll = await tableRows(page, "mods");

  // A collection install is a long run of installs, each dispatching dozens of state
  // updates; with every row rendered, each update re-renders thousands of cells and the
  // UI freezes between them.
  if (installs > 0) {
    await page.evaluate(`(() => {
      window.__largeLibraryTasks = [];
      window.__largeLibraryObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__largeLibraryTasks.push(entry.duration);
      });
      window.__largeLibraryObserver.observe({ type: "longtask" });
    })()`);
    // Vortex's own log for the span of the installs: per-install sorts, backups, memory
    // warnings (LAZ-1079), and persistence churn.
    const installStatus = await mcp.call<{ userDataDir: string | null }>("automation_status");
    const installMark =
      installStatus.userDataDir === null ? undefined : markLog(installStatus.userDataDir);
    const start = Date.now();
    // A name per run: an archive installed by an earlier run makes Vortex ask whether to
    // replace the mod, and nothing answers that unattended.
    const runId = String(start);
    for (let i = 0; i < installs; i++) {
      const archive = path.join(config.cacheDir, `large-library-install-${runId}-${String(i)}.zip`);
      fs.writeFileSync(
        archive,
        zipSync({ [`burst/large-library-${runId}-${String(i)}.txt`]: strToU8("x") }),
      );
      await installLocalMod(mcp, archive);
    }
    const wallMs = Date.now() - start;
    await page.waitForTimeout(3_000);
    const tasks = (await page.evaluate(`(() => {
      window.__largeLibraryObserver.disconnect();
      return window.__largeLibraryTasks;
    })()`)) as number[];
    const longestMs = Math.round(Math.max(0, ...tasks));
    result.installs = {
      count: installs,
      wallMs,
      longTasks: tasks.length,
      longestMs,
      log: installMark === undefined ? null : summariseLog(readSince(installMark)),
    };
    if (longestMs > MAX_INSTALL_FREEZE_MS) {
      failures.push(
        `installing ${String(installs)} mods froze the UI for up to ${String(longestMs)}ms at a ` +
          `time (allowed ${String(MAX_INSTALL_FREEZE_MS)})`,
      );
    }
  }

  if (deploy) {
    // A deploy time is only evidence if the deploy did the whole job: the purge before
    // it has to leave nothing behind, and the deploy has to link every file back.
    const gamePath = await mcp.call<string>("vortex_query", {
      path: ["settings", "gameMode", "discovered", gameId, "path"],
    });
    const deployed = path.join(gamePath, "Data", "library");
    const deployedCount = (): number =>
      fs.existsSync(deployed)
        ? fs.readdirSync(deployed).filter((f) => f.startsWith("vortex-ai-library-")).length
        : 0;
    const expected = count * 3;
    // Never delete a file the deployment manifest owns, even if a purge left it behind:
    // removing it under Vortex makes the next deploy stop on "links were deleted", whose
    // default answer deletes the staging files. Stop and say so instead.
    // Orphans are different: copies no manifest lists (an interrupted earlier run can
    // leave them) are invisible to Vortex, so removing them changes nothing it tracks.
    const removeOrphans = (): number => {
      const manifest = path.join(gamePath, "Data", "vortex.deployment.json");
      const owned = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8") : "";
      let removed = 0;
      for (const f of fs.existsSync(deployed) ? fs.readdirSync(deployed) : []) {
        if (!f.startsWith("vortex-ai-library-") || owned.includes(f)) continue;
        fs.rmSync(path.join(deployed, f));
        removed++;
      }
      return removed;
    };
    const timedFullDeploy = async (where: string): Promise<number> => {
      await purgeGame(mcp, { onProgress: console.log });
      const orphans = removeOrphans();
      if (orphans > 0) result.removedOrphans = orphans;
      if (deployedCount() !== 0) {
        throw new Error(
          `the purge before the ${where} deploy left ${String(deployedCount())} fixture files in ` +
            `${deployed}. Another instance or a deploy still running may own them; purge from ` +
            `Vortex (or with \`vortex-ai purge\`) and rerun rather than deleting them by hand.`,
        );
      }
      const ms = await timeDeploy(mcp, gameId);
      if (deployedCount() < expected) {
        throw new Error(
          `the ${where} deploy linked ${String(deployedCount())} of ${String(expected)} files`,
        );
      }
      return ms;
    };

    const onMods = await timedFullDeploy("Mods page");
    await openPage("Settings");
    const elsewhere = await timedFullDeploy("Settings page");
    result.deployMs = { onMods, elsewhere, ratio: Number((onMods / elsewhere).toFixed(2)) };
    if (onMods > elsewhere * MAX_DEPLOY_RATIO) {
      failures.push(
        `deploying from the Mods page took ${String(onMods)}ms against ${String(elsewhere)}ms ` +
          `from Settings (allowed ${String(MAX_DEPLOY_RATIO)}x)`,
      );
    }
  }
} finally {
  await mcp
    .call("vortex_dispatch", { action: "setUseModernLayout", args: [originalLayout !== false] })
    .catch(() => undefined);
  await mcp
    .call("vortex_dispatch", { action: "setAutoDeployment", args: [originalAutoDeploy !== false] })
    .catch(() => undefined);
  await handle.close();
}

result.failures = failures;
fs.mkdirSync(config.artifactDir, { recursive: true });
const report = path.join(config.artifactDir, `large-library-${layout}-${String(Date.now())}.json`);
fs.writeFileSync(report, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(`evidence: ${report}`);
if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
