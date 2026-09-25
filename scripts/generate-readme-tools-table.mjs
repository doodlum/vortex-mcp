#!/usr/bin/env node
// Regenerates the "## Tools" table in README.md from the LIVE server's real
// tools/list response, instead of hand-transcribed descriptions -- which is
// exactly how the README drifted out of sync with the code twice in one
// session (a missing tool in the Safety section's write-tool list, a stale
// tool count). Requires Vortex to be running locally with this extension
// loaded (this is a dev-time doc generator, not part of the build).
//
// Read-vs-write tagging isn't part of the MCP protocol's tools/list response,
// so it's the one piece of metadata still hand-maintained here -- keep it in
// sync when a tool's access tier changes, everything else regenerates.
//
// Usage: node scripts/generate-readme-tools-table.mjs [--check]
//   --check   exit 1 if README.md's table doesn't match the live server
//             (verify the docs are current without rewriting them)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PORT = process.env.VORTEX_MCP_PORT ?? "3701";
const TOKEN = process.env.VORTEX_MCP_TOKEN;
const URL = `http://127.0.0.1:${PORT}/mcp`;

const ACCESS_TIER = {
  automation_status: "read",
  nexus_auth_status: "read",
  collection_status: "read",
  collection_install_state: "read",
  check_probe_counts: "read",
  ui_active_dialogs: "read",
  perf_trace_start: "write",
  perf_trace_stop: "write",
  perf_trace_status: "write",
  ui_snapshot: "read",
  ui_wait_for: "read",
  ui_get_viewport: "read",
  ui_detect_layout_issues: "read",
  ui_read_console: "read",
  ui_click: "write",
  ui_fill: "write",
  ui_press_key: "write",
  ui_hover: "write",
  ui_select_option: "write",
  ui_scroll: "write",
  ui_set_viewport: "write",
  ui_responsive_sweep: "write",
  ui_reload_renderer: "write",
  vortex_quit: "write",
  vortex_describe: "read",
  scan_extension_actions: "read",
  vortex_query: "read",
  list_profiles: "read",
  list_mods: "read",
  list_load_order: "read",
  get_plugin_details: "read",
  list_categories: "read",
  list_downloads: "read",
  list_notifications: "read",
  list_mod_rules: "read",
  find_mod_dependents: "read",
  list_dialogs: "read",
  list_external_changes: "read",
  find_mod_by_file: "read",
  list_file_conflicts: "read",
  find_missing_masters: "read",
  list_runtime_errors: "read",
  list_duplicate_mods: "read",
  find_stale_mods: "read",
  find_stale_downloads: "read",
  list_known_mod_conflicts: "read",
  list_unsolved_conflicts: "read",
  find_missing_deployed_files: "read",
  find_orphaned_files: "read",
  check_nexus_mod_updates: "write",
  switch_profile: "write",
  clone_profile: "write",
  vortex_dispatch: "write",
  poll_listener: "write",
  backup_state: "write",
  set_mods_enabled: "write",
  launch_game: "write",
  vortex_restart: "write",
};

async function readFirstEvent(res) {
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || res.body === null) {
    return res.text();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (/^data: .*\n/m.test(text)) break;
  }
  await reader.cancel().catch(() => undefined);
  return text;
}

async function callMcp(body) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (TOKEN !== undefined) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
  const res = await fetch(URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  // A text/event-stream response can stay open after its one event, so read until a complete
  // `data:` line has arrived rather than waiting for the stream to end.
  const text = await readFirstEvent(res);
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!res.ok || (dataLine === undefined && !text.trim().startsWith("{"))) {
    throw new Error(
      `Unexpected response from ${URL} (status ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(dataLine === undefined ? text : dataLine.slice("data: ".length));
  if (parsed.error !== undefined) {
    throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

async function fetchTools() {
  await callMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "generate-readme-tools-table", version: "0.0.1" },
    },
  });
  const result = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return result.tools;
}

// Tool descriptions are written verbose for the calling agent (that's their real
// job -- vortex_describe surfaces the full text). A README table needs a human-
// skimmable summary instead, so take the first sentence (or hard-truncate) rather
// than embedding the whole thing -- still purely derived, so it can't drift, just
// shorter. Escape `|` since it's a markdown table cell delimiter.
const ABBREVIATIONS = ["e.g", "i.e", "etc"];

function findSentenceEnd(description) {
  let searchFrom = 0;
  while (true) {
    const idx = description.indexOf(". ", searchFrom);
    if (idx === -1) {
      return -1;
    }
    const precededByAbbreviation = ABBREVIATIONS.some((abbr) =>
      description.slice(0, idx + 1).endsWith(`${abbr}.`),
    );
    if (!precededByAbbreviation) {
      return idx;
    }
    searchFrom = idx + 2;
  }
}

function summarize(description, maxLen = 140, minLen = 25) {
  const periodIdx = findSentenceEnd(description);
  let summary =
    periodIdx !== -1 && periodIdx + 1 >= minLen && periodIdx < maxLen
      ? description.slice(0, periodIdx + 1)
      : description;
  if (summary.length > maxLen) {
    summary = `${summary.slice(0, maxLen - 1).trimEnd()}…`;
  }
  return summary.replace(/\|/g, "\\|");
}

function pad(s, w) {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function buildTable(tools) {
  const rows = tools
    .map((tool) => {
      const access = ACCESS_TIER[tool.name];
      if (access === undefined) {
        throw new Error(
          `Tool '${tool.name}' has no entry in ACCESS_TIER -- add one to this script.`,
        );
      }
      return { name: tool.name, access, description: summarize(tool.description) };
    })
    .toSorted((a, b) => (a.access === b.access ? 0 : a.access === "read" ? -1 : 1));

  const nameWidth = Math.max(...rows.map((r) => r.name.length + 2), "Tool".length);
  const descWidth = Math.max(...rows.map((r) => r.description.length), "What it does".length);

  const lines = [
    `| ${pad("Tool", nameWidth)} | Access | ${pad("What it does", descWidth)} |`,
    `| ${"-".repeat(nameWidth)} | ------ | ${"-".repeat(descWidth)} |`,
    ...rows.map(
      (r) =>
        `| ${pad(`\`${r.name}\``, nameWidth)} | ${r.access.padEnd(6)} | ${pad(r.description, descWidth)} |`,
    ),
  ];
  return lines.join("\n");
}

async function main() {
  const check = process.argv.includes("--check");
  const tools = await fetchTools();
  const table = buildTable(tools);

  const readmePath = path.resolve(import.meta.dirname, "..", "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const startMarker = "<!-- TOOLS_TABLE_START -->";
  const endMarker = "<!-- TOOLS_TABLE_END -->";
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README.md is missing ${startMarker}/${endMarker} markers.`);
  }

  const before = readme.slice(0, startIdx + startMarker.length);
  const after = readme.slice(endIdx);
  const updated = `${before}\n\n${table}\n\n${after}`;

  if (check) {
    if (updated !== readme) {
      console.error("README.md's tools table is out of date. Run: pnpm run docs:tools");
      process.exitCode = 1;
      return;
    }
    console.log("README.md's tools table is up to date.");
    return;
  }

  writeFileSync(readmePath, updated);
  console.log(`Updated README.md's tools table from ${tools.length} live tools.`);
}

// process.exitCode (not process.exit()) so Node drains the fetch keep-alive
// socket before exiting -- an abrupt exit() here raced a still-closing
// libuv async handle and crashed the process natively (UV_HANDLE_CLOSING
// assertion) rather than exiting cleanly.
main().catch((err) => {
  console.error(err.message);
  console.error(
    "\nThis generator needs Vortex running locally with vortex-mcp loaded " +
      `(VORTEX_MCP_PORT=${PORT}, VORTEX_MCP_TOKEN=${TOKEN === undefined ? "<unset>" : "<set>"}).`,
  );
  process.exitCode = 1;
});
