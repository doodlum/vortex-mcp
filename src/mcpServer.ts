import http from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import { z } from "zod";

import type { types } from "@nexusmods/vortex-api";
import { log, util } from "@nexusmods/vortex-api";
import * as control from "./vortexControl";
import * as ui from "./uiAutomation";
import * as perf from "./perfTrace";
import { probeCounts } from "./checkProbe";
import { authStatus } from "./authStatus";

type IExtensionApi = types.IExtensionApi;

// Opt-in staleness guard for writes — see assertExpectedContext's own doc comment in
// vortexControl.ts for why this exists (a real cold-run incident: the active profile
// silently reverted mid-analysis with zero signal from any tool here). Shared across
// every write tool that can be meaningfully mis-targeted by a stale assumption about
// what's currently active.
const expectedContextSchema = {
  expectedActiveProfileId: z
    .string()
    .optional()
    .describe(
      "If set, throws instead of proceeding when this isn't the active profile right now " +
        "— guards against the active profile having changed since you last checked it " +
        "(another agent, the user's own Vortex UI, anything). Omit to skip the check.",
    ),
  expectedActiveGameId: z
    .string()
    .optional()
    .describe(
      "If set, throws instead of proceeding when this isn't the active game right now. " +
        "Omit to skip the check.",
    ),
};

const PORT = Number(process.env.VORTEX_MCP_PORT ?? 3701);
const HOST = "127.0.0.1";
// Set VORTEX_MCP_TOKEN to require `Authorization: Bearer <token>` on every request AND to
// unlock the write tools (see startMcpServer) — with no token, only read tools are ever
// registered. Host/Origin checks below are what actually stop DNS-rebinding (a page whose
// hostname resolves to 127.0.0.1); the token is a second, independent gate for writes.
const TOKEN = process.env.VORTEX_MCP_TOKEN;
const RUNTIME_ID = randomUUID();

// Vortex's `confidential` state hive (Nexus API key, OAuth credentials, and anything
// else Vortex core itself treats as a credential — see Application.ts's registerHive
// and store.ts's own exclusion of it from backups) is the one part of the reflected
// state tree that's actually sensitive. Every other selector/path vortex_query can
// reach is harmless mod/profile/game state, so this is a targeted invariant, not a
// return to the curated allowlist this project deliberately removed for writes: it
// names no selectors and no paths, just the one structural hive Vortex core already
// marks as confidential.
const CONFIDENTIAL_REDACTED = "[redacted: state.confidential]";
// A floor on redacted string values, not just object nodes: apiKey-style selectors
// return a freshly computed string with no path a structural check could see, so the
// string itself has to be matched by value too. The floor keeps a short, benign
// string (a username, a locale code) from colliding by coincidence.
const MIN_REDACTED_STRING_LENGTH = 16;

function collectConfidentialProvenance(confidential: unknown): {
  nodes: WeakSet<object>;
  values: Set<string>;
} {
  const nodes = new WeakSet<object>();
  const values = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.length >= MIN_REDACTED_STRING_LENGTH) {
        values.add(node);
      }
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    nodes.add(node);
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(confidential);
  return { nodes, values };
}

// JSON.stringify(undefined) returns the actual `undefined` value, not a string —
// a legitimate result (an unresolved vortex_query path/selector, found live: an
// MCP response's content[].text must be a string, so an ungated JSON.stringify
// crashed the whole call at the SDK's own response-schema validation instead of
// returning a clean "null"). `?? null` guarantees a real JSON string every time.
//
// Redaction happens here — the one funnel every tool response already passes
// through via JSON.stringify's own tree walk — rather than by gating individual
// selectors/paths before they run. Redacting the input state instead (e.g. handing
// selectors a state whose `confidential` node is replaced first) was considered and
// rejected: it corrupts legitimate selectors that derive a non-secret fact from that
// subtree (an isLoggedIn-shaped check), returning a wrong answer instead of a visible
// redaction. This applies to every read regardless of whether VORTEX_MCP_TOKEN is
// set — a human at Vortex's own UI can't read their stored credential back out as
// plaintext either, so redaction is the UI-parity floor, not a tier a token lifts.
function makeJsonText(api: IExtensionApi): (value: unknown) => { type: "text"; text: string } {
  return (value: unknown) => {
    const { confidential } = api.getState();
    const { nodes, values } = collectConfidentialProvenance(confidential);
    const text = JSON.stringify(
      value ?? null,
      (_key, val: unknown) => {
        if (typeof val === "object" && val !== null && nodes.has(val)) {
          return CONFIDENTIAL_REDACTED;
        }
        if (typeof val === "string" && values.has(val)) {
          return CONFIDENTIAL_REDACTED;
        }
        return val;
      },
      2,
    );
    return { type: "text", text };
  };
}

function registerReadTools(server: McpServer, api: IExtensionApi): void {
  registerCheckProbeTool(server, api);
  registerDiscoveryTools(server, api);
  registerModInventoryTools(server, api);
  registerDownloadAndRuleTools(server, api);
  registerDiagnosticTools(server, api);
  registerDialogTools(server, api);
  registerUiReadTools(server, api);
}

/** The per-user folders Vortex resolved, or null for one it cannot report. */
function vortexPaths(): { documents: string | null; localAppData: string | null } {
  const resolve = (id: "documents" | "localAppData"): string | null => {
    try {
      return util.getVortexPath(id);
    } catch {
      return null;
    }
  };
  return { documents: resolve("documents"), localAppData: resolve("localAppData") };
}

function registerCheckProbeTool(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "check_probe_counts",
    {
      description:
        "How many times Vortex has run its health checks for each test event " +
        "(plugins-changed, mod-installed, mod-activated, settings-changed, gamemode-activated, " +
        "profile-did-change), counted by a no-op probe check this extension registers through " +
        "Vortex's own registerTest (harness instances only; empty otherwise). A count that stops " +
        "rising while its event keeps firing means Vortex is suppressing that event's checks — " +
        "which is how a warning like Missing Masters silently never appears. Checks run 500ms " +
        "after their event, debounced.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(process.env.VORTEX_E2E === "1" ? probeCounts() : [])],
    }),
  );
}

// Split from one large registerReadTools by domain — vortex_describe/scan_extension_actions/
// vortex_query all discover *what's callable* rather than reading specific game state.
function registerDiscoveryTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "automation_status",
    {
      description:
        "Identify this renderer lifetime and isolated harness profile. runtimeId changes after renderer reload; userDataDir is null outside the harness. `paths` are the per-user folders Vortex resolved (documents, localAppData) — what a Bethesda game's INI files and plugins.txt are written under — so a harness can refuse to manage a game unless they are its own sandbox copies. Contains no credentials.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        jsonText({
          runtimeId: RUNTIME_ID,
          userDataDir:
            process.env.VORTEX_E2E === "1" ? (process.env.ELECTRON_USERDATA ?? null) : null,
          paths: vortexPaths(),
        }),
      ],
    }),
  );
  server.registerTool(
    "nexus_auth_status",
    {
      description:
        "Report whether a Nexus API key, OAuth access token, and OAuth refresh token are " +
        "present, without returning credentials. Presence does not prove server validity; " +
        "Vortex manages token refresh. Check oauthPresent before collection operations.",
      inputSchema: z.object({}),
    },
    async () => ({ content: [jsonText(authStatus(api))] }),
  );
  server.registerTool(
    "vortex_describe",
    {
      description:
        "Discover the live Vortex API surface: callable selector names (for vortex_query, " +
        "with known caveats in `selectorHints`, e.g. selectorHints.knownGames warns it's a " +
        "5000-entry catalog that blows the response limit and points at 'discovered' " +
        "instead), every action/api.ext function/event/api method name dispatchable via " +
        "vortex_dispatch (`actions`/`extensionApis`/`eventNames`/`apiMethods` — all of these " +
        "are callable, no allowlist; the loopback bind + bearer token is the real security " +
        "boundary), with real positional argument order for the ones this project has " +
        "verified (`dispatchHints`/`extensionApiHints`/`eventHints`/`listenerHints`, e.g. " +
        'dispatchHints.setModEnabled = "profileId: string, modId: string, enable: boolean" ' +
        "— missing from these maps just means no pre-verified arg order/caveat, not that " +
        'it\'s unavailable; eventHints/listenerHints also document the "__CALLBACK__" ' +
        "sentinel position for the few events/apiMethods that need one — a listenerHints " +
        "entry means that apiMethod registers a persistent listener instead of performing a " +
        "one-off action; see poll_listener), and top-level Redux state keys (for " +
        "vortex_query's path mode, includes state added by any loaded extension, not just " +
        "core Vortex). Reflects whatever Vortex is actually running right now — new " +
        "selectors/actions/events/state show up here without an extension rebuild.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.describeApi(api))],
    }),
  );

  server.registerTool(
    "scan_extension_actions",
    {
      description:
        "Discover real dispatchable Redux action type strings — and, where recoverable, " +
        "their payload shape — by scanning every installed extension's own compiled JS " +
        "on disk (bundled + user-installed, both plain files, no source checkout or " +
        "app.asar archive parsing needed). This is what most action creators defined " +
        "inside an extension's own module (as opposed to Vortex core) actually need: " +
        "vortex_describe's `actions` list only contains what's re-exported through the " +
        "published @nexusmods/vortex-api package, which most extension-internal action " +
        "creators (confirmed live: 79 of 81 across this install's extensions) never are " +
        "— those are otherwise undiscoverable, not just undocumented. Each result's " +
        "`type` is usable directly with vortex_dispatch as action='type:<type>'. " +
        "`payloadKeys` maps each payload object key to which positional argument (0-" +
        "indexed) it came from in the original creator — e.g. {pluginName: 0, enabled: " +
        "1} means dispatch with args=[{pluginName: <value>, enabled: <value>}]. " +
        "`passthroughPayload: true` means the payload IS the single argument directly — " +
        "dispatch with args=[<value>] (no wrapping object). `noPayload: true` means the " +
        "action creator takes no argument at all — dispatch with args=[] (this is a " +
        "CONFIRMED shape, not an unknown one). When payloadKeys is empty and both flags " +
        "are false, the type string was recovered but its shape wasn't recognized — " +
        "still more than nothing, but verify the shape yourself before dispatching. " +
        "IMPORTANT LIMIT: this recovers dispatch SHAPE, not reducer BEHAVIOR — the " +
        "creator's argument shape and what the reducer actually does with it are two " +
        "separate pieces of code, only the first is scanned. Confirmed live: gamebryo-" +
        "plugin-management's TOGGLE_TUTORIAL (shape {tutorialId: 0, isOpen: 1}) silently " +
        "ignores the isOpen value and forces true whenever tutorialId differs from the " +
        "currently-open one — dispatching a 'correct-shaped' payload does not guarantee " +
        "the effect its field names imply. Read state before AND after your first real " +
        "dispatch of any newly-discovered action to confirm what it actually does, don't " +
        "trust the shape alone. One reassuring counterpoint, also confirmed live: " +
        "gamebryo-plugin-management's userlist-related actions (setGroup/addRule/" +
        "removeRule/addGroup/removeGroup/addGroupRule/removeGroupRule) all match plugin " +
        "names case-INsensitively when updating an existing entry — exact casing of a " +
        "pluginId/pluginName argument doesn't matter for those, confirmed by dispatching " +
        "a deliberately-wrong-case pluginId live and observing it correctly update the " +
        "existing entry with no duplicate created — but this is specific to that " +
        "extension's userlist reducers, not a guarantee for every action found here. " +
        "Cached after the first call " +
        "(these files only change when Vortex/an extension updates) — pass forceRefresh " +
        "to re-scan after an update. A real filesystem scan across every installed " +
        "extension, not instant, but a one-time cost per process lifetime.",
      inputSchema: z.object({
        forceRefresh: z
          .boolean()
          .optional()
          .describe("Re-scan instead of returning the cached result from an earlier call"),
      }),
    },
    async ({ forceRefresh }) => ({
      content: [jsonText(await control.scanExtensionActions(api, forceRefresh))],
    }),
  );

  server.registerTool(
    "vortex_query",
    {
      description:
        "Read Vortex state. Two modes: `selector` calls that named vortex-api selector as " +
        "`(state, ...args)` (e.g. selector='activeProfileId', or selector='profiles' then " +
        "cross-reference the id yourself); `path` walks the Redux state tree by key " +
        "(e.g. path=['persistent','mods','skyrimse']). Use vortex_describe first to see what's " +
        "available. Genuinely read-only (can't mutate anything) — for calling an api.ext " +
        "function (which can have side effects), use vortex_dispatch instead. Anything sourced " +
        "from state.confidential (the stored Nexus API key/OAuth credential) comes back as " +
        '"[redacted: state.confidential]" — this is unconditional, not something the write ' +
        "token lifts; a selector that only derives a non-secret fact from that subtree (e.g. " +
        "isLoggedIn) is unaffected.",
      inputSchema: z.object({
        selector: z.string().optional(),
        args: z.array(z.unknown()).optional(),
        path: z.array(z.string()).optional(),
      }),
    },
    async ({ selector, args, path }) => {
      if (selector !== undefined) {
        return { content: [jsonText(control.querySelector(api, selector, args))] };
      }
      if (path !== undefined) {
        return { content: [jsonText(control.queryStatePath(api, path))] };
      }
      throw new Error("Provide either `selector` or `path`.");
    },
  );
}

// Mod/plugin/profile inventory reads.
function registerModInventoryTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "list_profiles",
    {
      description:
        "List Vortex profiles (defaults to every game; pass gameId to filter to one), with " +
        "name, active status, and mod counts — a formatted join vortex_query can't do in one " +
        "call: the raw path (persistent.profiles) dumps every profile's full per-mod enabled " +
        "state, which can run past 500K characters and blow the response limit on a large " +
        "modlist (found live). Sorted most-recently-activated first.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Filter to profiles for this game id"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.listProfiles(api, gameId))],
    }),
  );

  server.registerTool(
    "collection_status",
    {
      description:
        "Whether each installed collection is COMPLETE, by Vortex's own definition — the same " +
        'check behind the Collections page\'s "Incomplete" badge. Use this, not a mod count, to ' +
        "decide whether a collection finished: a collection can have every member installed, " +
        "correctly named and nothing left installing, and still be incomplete, because Vortex " +
        "resolves each required rule through its own reference matcher AND requires the matched " +
        "mod to be enabled in the active profile. Unsatisfied rules are listed, and " +
        'installedButDisabled distinguishes "never installed" from "installed but switched off".',
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.collectionStatus(api, gameId))],
    }),
  );

  server.registerTool(
    "list_mods",
    {
      description:
        "List mods for a game (defaults to the active game), with friendly names and enabled " +
        "state for the active profile — a formatted join vortex_query can't do in one call. " +
        "A large modlist (hundreds of mods) can exceed the client's response size limit; use " +
        "enabledOnly/nameFilter/limit to narrow the result rather than requesting everything.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        enabledOnly: z.boolean().optional().describe("Only include currently-enabled mods"),
        nameFilter: z.string().optional().describe("Case-insensitive substring match on mod name"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of results returned"),
      }),
    },
    async ({ gameId, enabledOnly, nameFilter, limit }) => ({
      content: [jsonText(control.listMods(api, gameId, { enabledOnly, nameFilter, limit }))],
    }),
  );

  server.registerTool(
    "list_load_order",
    {
      description:
        "List the current Gamebryo/LOOT plugin load order (.esp/.esm/.esl), sorted by index. " +
        "Only available for games using plugin-based load ordering (e.g. Skyrim, Fallout) — " +
        "throws for games that don't have one active.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listLoadOrder(api))],
    }),
  );

  server.registerTool(
    "get_plugin_details",
    {
      description:
        "Get the same rich per-plugin info Vortex's own Plugins tab shows — master " +
        "list, LOOT messages/warnings, dirty-edit status (ITM/UDR), group, version — by " +
        "triggering the SAME real LOOT lookup the UI panel and the LOOT-sort mechanism " +
        "both use, merged with load order (index/enabled) and the base record Vortex " +
        "already caches (modId, deployed, isNative). list_load_order alone only gives " +
        "you index/enabled — this is the rest of what the tab surfaces. Only supports " +
        "the active game (load order and plugin state have no per-game storage for an " +
        "inactive game). A real, potentially slow LOOT call — capped at 25 plugins and " +
        "30s per call, pass a subset and make repeat calls for a full modlist. " +
        "`messages` is opaque (from the `loot` native package, not vendored here) — read " +
        "fields as found rather than assuming a schema.",
      inputSchema: z.object({
        pluginNames: z
          .array(z.string())
          .min(1)
          .max(25)
          .describe("Plugin file names to fetch details for; max 25 per call"),
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ pluginNames, gameId }) => ({
      content: [jsonText(await control.getPluginDetails(api, pluginNames, gameId))],
    }),
  );

  server.registerTool(
    "list_categories",
    {
      description:
        "List a game's mod categories (defaults to the active game), sorted by display order, " +
        "with a mod count per category — a join vortex_query can't do in one call.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.listCategories(api, gameId))],
    }),
  );
}

// Downloads and mod-rule/conflict-linkage reads.
function registerDownloadAndRuleTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "list_downloads",
    {
      description:
        "List the download queue/history for a game (defaults to the active game): name, " +
        "state, progress percent, size, start time, installedModId — a formatted view raw " +
        "vortex_query selectors (downloadsForGame/activeDownloads) don't give you in one " +
        "call. Defaults to every state except 'finished' (found live: a real download " +
        "history can run hundreds of entries deep and blow the response size limit if you " +
        "dump it all — what's usually wanted is what's active/stuck/failed, not the " +
        "archive). Pass states=['finished'] (optionally alongside others) to include " +
        "completed downloads; use limit to cap results, most-recently-started first. To " +
        "check whether a specific download is currently installed as a mod, use " +
        "installedModId (matches list_mods'/find_mod_by_file's id) rather than matching by " +
        "name — Nexus display names and installed-mod names commonly diverge. Note: " +
        "installedModId can be stale for a superseded download of a mod that's since been " +
        "updated in place under the same modId.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        states: z
          .array(z.string())
          .optional()
          .describe(
            "Only these download states (init/started/paused/finalizing/finished/failed/" +
              "redirect); omit for every state except 'finished'",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of results, most-recently-started first"),
      }),
    },
    async ({ gameId, states, limit }) => ({
      content: [jsonText(control.listDownloads(api, gameId, { states, limit }))],
    }),
  );

  server.registerTool(
    "find_stale_downloads",
    {
      description:
        "Group downloads that came from the SAME Nexus mod page (not the same field " +
        "list_downloads' installedModId reads — this groups by the Nexus page id nested " +
        "in each download's own metadata) and report every group with more than one " +
        "entry: multiple archives ever downloaded for one mod, typically old versions " +
        "left behind after updating. Each entry's `installed` flags whether THAT " +
        "download's content is currently deployed — confirmed live that MORE THAN ONE " +
        "entry in a group can show true simultaneously (Vortex updates a mod in place " +
        "under the same modId, so an older download can keep a stale-but-live-looking " +
        "installed pointer even though a newer one is what's actually deployed), so " +
        "don't assume exactly one true value. Every entry showing installed:false is a " +
        "real candidate for manual deletion to reclaim disk space. Reports raw facts " +
        "only, no verdict; you may have a real reason to keep an old version.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.findStaleDownloads(api, gameId))],
    }),
  );

  server.registerTool(
    "list_notifications",
    {
      description:
        "List Vortex's current notifications (errors, warnings, info) — what Vortex itself " +
        "is currently flagging as a problem, useful for diagnosing 'mod is enabled but " +
        "doesn't work'-class issues.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listNotifications(api))],
    }),
  );

  server.registerTool(
    "list_mod_rules",
    {
      description:
        "List a mod's dependency/conflict rules (before/after/requires/conflicts/...), " +
        "resolving each reference to the target mod's friendly name when it's installed — " +
        "a join vortex_query can't do in one call.",
      inputSchema: z.object({
        modId: z
          .string()
          .min(1, "modId is required (query list_mods to find one)")
          .describe("Mod id (query list_mods to find one)"),
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ modId, gameId }) => ({
      content: [jsonText(control.listModRules(api, modId, gameId))],
    }),
  );

  server.registerTool(
    "find_mod_dependents",
    {
      description:
        "Find every OTHER installed mod whose own rules reference this one — the reverse " +
        "of list_mod_rules, which only shows rules recorded ON the mod you ask about. " +
        "Answers 'what depends on/conflicts with/orders around this mod', e.g. before " +
        "removing or updating it. A join vortex_query/list_mod_rules can't do in one call " +
        "without scanning every other installed mod yourself.",
      inputSchema: z.object({
        modId: z
          .string()
          .min(1, "modId is required (query list_mods to find one)")
          .describe("Mod id (query list_mods to find one)"),
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ modId, gameId }) => ({
      content: [jsonText(control.findModDependents(api, modId, gameId))],
    }),
  );

  server.registerTool(
    "find_mod_by_file",
    {
      description:
        "Find which installed mod(s) contain a file with this name, by scanning mod " +
        "staging folders on disk (no reflectable API exposes this). Scans only enabled " +
        "mods by default — fast; pass includeDisabled to search every installed mod " +
        "instead (much slower for a large modlist, but useful for an orphaned/leftover " +
        "file whose owning mod isn't currently enabled).",
      inputSchema: z.object({
        filename: z.string().describe("Bare file name to search for, e.g. 'texture.dds'"),
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        includeDisabled: z
          .boolean()
          .optional()
          .describe("Search every installed mod, not just enabled ones (slower)"),
      }),
    },
    async ({ filename, gameId, includeDisabled }) => ({
      content: [jsonText(await control.findModByFile(api, filename, { gameId, includeDisabled }))],
    }),
  );

  server.registerTool(
    "list_file_conflicts",
    {
      description:
        "List files provided by more than one currently-enabled mod (for the active/given " +
        "profile) — the read side of conflict resolution; found by scanning mod staging " +
        "folders on disk, no reflectable API exposes this. Each entry's `risk` is a coarse " +
        "file-type hint (high: plugins/scripts/archives, medium: interface/config, low: " +
        "everything else, e.g. meshes/textures) — not a winner. Doesn't report a winner — " +
        "Vortex's actual resolution depends on deploy/rule order in ways not safe to " +
        "reimplement here. Resolve a conflict via vortex_dispatch: setFileOverride to pick " +
        "a winning mod for specific files, or addModRule with type 'before'/'after' to " +
        "control deploy order between two mods.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        nameFilter: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on the conflicting file's path"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of results returned"),
      }),
    },
    async ({ gameId, nameFilter, limit }) => ({
      content: [jsonText(await control.listFileConflicts(api, { gameId, nameFilter, limit }))],
    }),
  );
}

// Health/diagnostic reads — missing masters, runtime errors, duplicate/stale/conflicting
// mods, orphaned files, Nexus update checks.
function registerDiagnosticTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "find_missing_masters",
    {
      description:
        "Find enabled plugins whose master files aren't themselves enabled — reads each " +
        "plugin's real TES4 header from the game's Data folder (the Bethesda plugin " +
        "format's own binary spec, not Vortex-specific), since Vortex doesn't expose a " +
        "resolved-masters selector. A very common real troubleshooting need (a patch " +
        "enabled without its base mod).",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(await control.findMissingMasters(api, gameId))],
    }),
  );

  server.registerTool(
    "list_runtime_errors",
    {
      description:
        "Read recent Papyrus error lines and crash log excerpts from the game's real " +
        "save-data folder (Documents/My Games/<game>) — Vortex has no concept of game " +
        "runtime logs, this is pure filesystem reading. Doesn't try to parse or explain " +
        "crash log internals (format varies by crash-logging mod) — surfaces the raw " +
        "excerpt for you to reason about. Each entry's `mentionedFiles` lists any .esp/" +
        ".esm/.esl/.dll/.pex filenames spotted in the text — pass one to find_mod_by_file " +
        "to resolve which mod it belongs to. Only supports games with a verified save-data " +
        "folder name (currently skyrimse, skyrimvr) — throws clearly for anything else.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        maxCrashLogs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap how many recent crash logs to include (default 3)"),
      }),
    },
    async ({ gameId, maxCrashLogs }) => ({
      content: [jsonText(await control.listRuntimeErrors(api, { gameId, maxCrashLogs }))],
    }),
  );

  server.registerTool(
    "list_duplicate_mods",
    {
      description:
        "Find installed mods that look like duplicates or redundant leftovers — never " +
        "auto-resolved, purely informational (same 'report candidates, don't decide' " +
        "stance as list_file_conflicts). Two checks: more than one installed mod sharing " +
        "the same Nexus mod id (metadata-only, cheap), and mods whose entire file set is " +
        "contained in another mod's (usually an old/redundant version left installed). " +
        "Scans only enabled mods by default — fast; includeDisabled searches every " +
        "installed mod instead (much slower for a large modlist).",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        includeDisabled: z
          .boolean()
          .optional()
          .describe("Search every installed mod, not just enabled ones (slower)"),
      }),
    },
    async ({ gameId, includeDisabled }) => ({
      content: [jsonText(await control.listDuplicateMods(api, { gameId, includeDisabled }))],
    }),
  );

  server.registerTool(
    "find_stale_mods",
    {
      description:
        "List DISABLED mods for a profile (defaults to the active one), sorted oldest-" +
        "disabled first — candidates for actually removing rather than leaving disabled " +
        "forever. `disabledSince` is when the mod's enabled state was last toggled " +
        "(despite Vortex's own field name for it, enabledTime, this is set even for " +
        "currently-disabled mods and tracks the last flip either direction) — how long " +
        "ago that was is the real 'how stale' signal, not the enabled flag alone. " +
        "Reports raw facts only, no verdict: a mod can be deliberately kept disabled as " +
        "an alternate (e.g. two versions of a texture pack for different playthroughs).",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        profileId: z.string().optional().describe("Profile id; defaults to the active profile"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of results, oldest-disabled first"),
      }),
    },
    async ({ gameId, profileId, limit }) => ({
      content: [jsonText(control.findStaleMods(api, { gameId, profileId, limit }))],
    }),
  );

  server.registerTool(
    "list_known_mod_conflicts",
    {
      description:
        "Surfaces real 'conflicts'-type rules Vortex already has recorded on enabled mods " +
        "(mod.rules — the same field list_mod_rules reads, often populated from Nexus mod " +
        "page metadata or added by the user). Genuine Vortex data, not invented " +
        "compatibility knowledge — `targetEnabled` tells you whether the conflicting mod " +
        "is actually active right now.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.listKnownModConflicts(api, gameId))],
    }),
  );

  server.registerTool(
    "list_unsolved_conflicts",
    {
      description:
        "List file conflicts between enabled mods that have NO rule resolving them yet — " +
        "the read side of Vortex's own conflict-resolution ('Set Rule') workflow, which " +
        "list_file_conflicts deliberately declines to editorialize on. Each entry " +
        "includes Vortex's OWN suggestion (before/after/null), the same recommendation " +
        "its in-app conflict dialog offers as 'Use Suggested' — real computed data from " +
        "the built-in mod-dependency-manager extension, not invented. To apply a " +
        "non-null suggestion: vortex_dispatch action='addModRule' args=[gameId, modId, " +
        "{type: suggestion, reference: {id: otherModId}}] — modId/otherModId come from " +
        "THIS entry, and the direction matters (get modId/otherModId backwards and " +
        "you'll order the mods the wrong way). A null suggestion means Vortex has no " +
        "confident answer and a human has to pick. Always scoped to the ACTIVE game — " +
        "no gameId param, this data doesn't exist per-game the way most state here does.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listUnsolvedConflicts(api))],
    }),
  );

  server.registerTool(
    "find_missing_deployed_files",
    {
      description:
        "Find plugins where Vortex's load-order state, what's actually deployed to the " +
        "game's Data folder, and what the game's own plugins.txt says is active all " +
        "disagree — reads both real files directly rather than trusting Vortex's " +
        "in-memory state alone, since a deploy can silently partially fail. " +
        "`activeInPluginsTxt` is `null` when the plugin isn't listed there at all — " +
        "normal for game/DLC masters, which the engine activates implicitly without an " +
        "entry, so that's never itself a discrepancy. No verdict about which source is " +
        "'right'. Only supports games with a verified save-data folder name (currently " +
        "skyrimse, skyrimvr).",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(await control.findMissingDeployedFiles(api, gameId))],
    }),
  );

  server.registerTool(
    "find_orphaned_files",
    {
      description:
        "Find files Vortex's own deployment manifest (<Data>/vortex.deployment.json — " +
        "the same bookkeeping Vortex reads for its own Purge) still attributes to a mod " +
        "that no longer has a matching entry in the current mod list, but that are still " +
        "physically present in the Data folder — the read side of a commonly-reported " +
        "Vortex complaint (uninstalling a mod sometimes leaves its .esp/texture files " +
        "behind). `source` is NOT a mod id — it's the owning mod's installationPath " +
        "(staging folder name), which can diverge from a mod's `id` across updates; " +
        "don't try to match it against list_mods' id directly. An empty result means " +
        "either genuinely nothing orphaned, or the game has never been deployed (no " +
        "manifest yet) — this tool can't distinguish those. Only covers the default mod " +
        "type's manifest.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(await control.findOrphanedFiles(api, gameId))],
    }),
  );

  server.registerTool(
    "check_nexus_mod_updates",
    {
      description:
        "Check installed Nexus-sourced mods for available updates via Vortex's own " +
        "built-in integration and the user's existing Vortex login — no separate API " +
        "key. Kept as a dedicated tool (unlike get-mod-info, now folded into " +
        "vortex_query's extApi mode) because it does a real join vortex_query can't do " +
        "in one call: resolving mod ids to full IMod records and filtering to Nexus-" +
        "sourced ones before calling the underlying api.ext function. Makes one real, " +
        "rate-limited network call per mod through Vortex's own nexusCheckModsVersion — " +
        "confirmed live to exceed a 300s MCP call timeout well before covering even a " +
        "modest (~50 mod) list, so every call caps itself at `limit` (25) mods rather " +
        "than trying everything and timing out with no partial results — this applies " +
        "even when you pass modIds explicitly, since the timeout risk is the same either " +
        "way. Check the result's eligibleCount vs checkedCount: if eligibleCount is " +
        "higher, there's more to check — pass the remaining mod ids explicitly in a " +
        "follow-up call to cover the rest in batches. Consumes the user's real Nexus API " +
        "request quota — don't call this in a loop.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        modIds: z
          .array(z.string())
          .optional()
          .describe(
            "Vortex mod ids to check; defaults to the first `limit` installed Nexus-" +
              "sourced mods. `limit` still applies when you pass this explicitly.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap on how many mods to check per call; default 25"),
      }),
    },
    async ({ gameId, modIds, limit }) => ({
      content: [jsonText(await control.checkNexusModUpdates(api, gameId, modIds, limit))],
    }),
  );
}

// Vortex's own dialog/external-change UI state.
function registerDialogTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "list_dialogs",
    {
      description:
        "List Vortex's currently-open GENERIC modal dialogs (showDialog-based — most " +
        "confirmation/question/error prompts) — distinct from list_notifications' toast " +
        "notifications. Each entry's `actions` array is the exact set of labels " +
        "closeDialog's actionKey must match (via vortex_dispatch) — read this before " +
        "responding, never guess a choice. Does NOT cover the 'files changed outside " +
        "Vortex' dialog that can block a deploy/purge/profile-switch — confirmed live " +
        "that one uses a separate mechanism entirely and stays invisible here even while " +
        "genuinely open and stalling a deploy; use list_external_changes for that one.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listDialogs(api))],
    }),
  );

  server.registerTool(
    "list_external_changes",
    {
      description:
        "List pending 'external changes' Vortex detected (a deployed file differs from " +
        "what Vortex itself put there) that are BLOCKING an in-progress deploy/purge/" +
        "profile-switch — confirmed live to be invisible to list_dialogs and to " +
        "list_notifications (which only shows a generic stalled 'Deploying' activity, no " +
        "hint it's actually stuck waiting on a decision). If a deploy/switch_profile call " +
        "seems to hang, check this. Each entry's `action` is Vortex's own already-chosen " +
        "default (e.g. 'newest'). RESOLUTION: requires Vortex's own " +
        "setExternalChangeAction/confirmExternalChanges extension APIs, which exist in " +
        "source but were confirmed NOT present in this build's live reflection as of this " +
        "writing (dispatching confirmExternalChanges failed with an unknown-action error) " +
        "— this tool can detect the block but not resolve it until a build that includes " +
        "them is running; until then, answer the dialog in Vortex's own UI.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listExternalChanges(api))],
    }),
  );
}

/**
 * Performance tracing. Write-tier although it changes no state: it wraps the store's
 * dispatch for the lifetime of the renderer, which is not something a read-only client
 * should be able to do to someone's Vortex.
 */
function registerPerfTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "perf_trace_start",
    {
      description:
        "Start timing the renderer: every Redux dispatch by action type (a dispatch runs " +
        "middleware including persistence diffing, reducers and subscribers synchronously), " +
        "every main-thread task over 50ms (where React rendering shows up), and the JS heap. " +
        "Discards any previous trace. Use around an operation that feels slow — a deploy, an " +
        "install, a filter change — then call perf_trace_stop. Outside a trace the cost is " +
        "one boolean check per dispatch.",
      inputSchema: z.object({
        heapSampleMs: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("How often to sample the heap. Defaults to 1000."),
      }),
    },
    async ({ heapSampleMs }) => {
      if (api.store === undefined) throw new Error("Vortex store not initialized yet");
      perf.installDispatchTracer(
        api.store as unknown as Parameters<typeof perf.installDispatchTracer>[0],
      );
      return { content: [jsonText(perf.startTrace({ heapSampleMs }))] };
    },
  );
  server.registerTool(
    "perf_trace_stop",
    {
      description:
        "Stop the trace started by perf_trace_start and return: duration; dispatch count and " +
        "total time; the action types that cost the most time and those dispatched most " +
        "often (count, total and max ms each); long-task count, total and max ms; and heap " +
        "start/max/end in MB. Time inside long tasks but outside dispatches is rendering or " +
        "other work — profile it over CDP to attribute it.",
      inputSchema: z.object({
        top: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Entries per list. Defaults to 15."),
      }),
    },
    async ({ top }) => ({ content: [jsonText(perf.stopTrace({ top }))] }),
  );
  server.registerTool(
    "perf_trace_status",
    {
      description: "Whether a perf trace is running, and for how long.",
      inputSchema: z.object({}),
    },
    async () => ({ content: [jsonText(perf.traceStatus())] }),
  );
}

function registerWriteTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  registerPerfTools(server, api);
  server.registerTool(
    "switch_profile",
    {
      description:
        "Switch Vortex to a different profile by id (query list_profiles to find one). NOT " +
        "instant or lightweight: read from Vortex's own profile_management source, this " +
        "purges the current profile's deployed files then deploys the new profile's mods — " +
        "real, potentially slow filesystem work, the same as switching profiles in the " +
        "Vortex UI. This tool call returns as soon as the switch is DISPATCHED, not once " +
        "deployment finishes — poll needToDeployForGame or watch for a 'deploying' " +
        "notification (list_notifications) if you need to know when it's actually done. " +
        "Switching to an unknown profileId throws. Pass expectedActiveProfileId to guard " +
        "against acting on a stale assumption about what's currently active — see its own " +
        "param description.",
      inputSchema: z.object({
        profileId: z.string().describe("Target profile id (query list_profiles to find one)"),
        expectedActiveProfileId: expectedContextSchema.expectedActiveProfileId,
      }),
    },
    async ({ profileId, expectedActiveProfileId }) => {
      control.switchProfile(api, profileId, { activeProfileId: expectedActiveProfileId });
      return { content: [{ type: "text", text: `Switched to profile ${profileId}` }] };
    },
  );

  server.registerTool(
    "clone_profile",
    {
      description:
        "Clone an existing profile into a new one (copies its on-disk profile directory " +
        "— load order, ini tweaks — plus its mod enabled-state), the same operation as " +
        "Vortex's own 'Clone' button. Only ever reads the source profile; never modifies it " +
        "or switches the active profile. The clone is always for the SAME game as the " +
        "source — there's no gameId param and no cross-game cloning. Returns the new " +
        "profile in the same summary shape list_profiles entries have (id, name, gameId, " +
        "active, modCount, enabledModCount, lastActivated).",
      inputSchema: z.object({
        sourceProfileId: z
          .string()
          .describe("Profile id to clone (query list_profiles to find one)"),
        name: z
          .string()
          .optional()
          .describe("Name for the new profile; defaults to '<source> (clone)'"),
      }),
    },
    async ({ sourceProfileId, name }) => {
      const cloned = await control.cloneProfile(api, sourceProfileId, name);
      return { content: [jsonText(cloned)] };
    },
  );

  server.registerTool(
    "vortex_dispatch",
    {
      description:
        "Dispatch a named Vortex action creator, api.ext function, event, or direct api " +
        "method — tried in that order. (1) Redux action creator (e.g. action='setModEnabled') " +
        "— NOT runtime-validated: found live that a wrong argument type (a string where a " +
        "boolean was expected) or a missing required argument both dispatch successfully with " +
        "no error, silently carrying the bad payload into the reducer/UI rather than " +
        "rejecting it here — double-check argument order/types yourself, especially for " +
        "anything missing from dispatchHints. (2) api.ext function (e.g. " +
        "action='nexusGetModInfo') — unlike action creators, these DO throw on a wrong " +
        "argument shape, but as a raw, unhelpful runtime error (e.g. a bare " +
        '"x.trim is not a function" with no indication which argument or what shape was ' +
        "expected) rather than a validation message — see extensionApiHints for the " +
        "verified subset, and expect to iterate by trial and error on anything else. " +
        "(3) a currently-registered " +
        "event name, emitted via api.events.emit — most fire-and-forget by default; pass " +
        '"__CALLBACK__" as one of the args at the position Vortex\'s own handler expects a ' +
        "Node-style (err, result?) => void callback and vortex_dispatch will await real " +
        "completion instead (e.g. action='deploy-mods', args=['__CALLBACK__'] resolves once " +
        "deployment actually finishes, not just once it started). (4) a direct method on the " +
        "api object itself (e.g. action='sendNotification') — a small subset of these " +
        "(onStateChange, onAsync, registerProtocol, registerRepositoryLookup; see " +
        "vortex_describe's `listenerHints`) register a persistent listener instead of " +
        'performing a one-off action: pass "__CALLBACK__" the same way, and this returns a ' +
        "listenerId immediately rather than waiting for anything — poll what it's captured " +
        "with poll_listener. (5) action='type:SOME_TYPE' (note the literal 'type:' prefix) " +
        "dispatches a raw {type, payload} Redux action directly, args[0] being the WHOLE " +
        "payload — an escape hatch for actions defined inside a game extension's own " +
        "module (e.g. gamebryo-plugin-management's per-plugin enable toggle) that aren't " +
        "re-exported through @nexusmods/vortex-api and so don't appear anywhere in path " +
        "(1)'s `actions` list at all — see dispatchHints for 'type:'-prefixed entries " +
        "this project has verified. Deliberately requires the explicit prefix rather than " +
        "silently falling back to a raw dispatch for any unrecognized name, since most " +
        "reducers ignore an unknown type — a typo would otherwise silently no-op instead " +
        "of throwing a clear error. Not allowlisted: everything in vortex_describe's `actions`/" +
        "`extensionApis`/`eventNames`/`apiMethods` lists is callable this way once you hold " +
        "the write-tier token — that token, not a curated list, is the actual security " +
        "boundary, matching what a human at Vortex's own UI can already do. Use " +
        "vortex_describe's `dispatchHints`/`extensionApiHints`/`eventHints`/`listenerHints` " +
        "for the real argument order (incl. the __CALLBACK__ position) where this project has " +
        "verified one; for anything else, check Vortex's source or test carefully with a " +
        "state read before/after. Pass expectedActiveProfileId/expectedActiveGameId to guard " +
        "against dispatching a write based on a stale assumption about what's currently " +
        "active — see their own param descriptions.",
      inputSchema: z.object({
        action: z.string().describe("Action creator, api.ext function, event, or api method name"),
        args: z
          .array(z.unknown())
          .optional()
          .describe(
            "Positional arguments for the action creator/function/event/method " +
              '(include "__CALLBACK__" at the callback position to await a callback-based ' +
              "event, or to register a persistent listener)",
          ),
        expectedActiveProfileId: expectedContextSchema.expectedActiveProfileId,
        expectedActiveGameId: expectedContextSchema.expectedActiveGameId,
      }),
    },
    async ({ action, args, expectedActiveProfileId, expectedActiveGameId }) => {
      const dispatched = await control.dispatchAction(api, action, args, {
        activeProfileId: expectedActiveProfileId,
        activeGameId: expectedActiveGameId,
      });
      return { content: [jsonText(dispatched)] };
    },
  );

  server.registerTool(
    "poll_listener",
    {
      description:
        "Read back what a persistent listener registered via vortex_dispatch (onStateChange/" +
        "onAsync/registerProtocol/registerRepositoryLookup) has captured. Non-destructive — " +
        "repeated polling with the same `since` returns the same entries; the listener's own " +
        "ring buffer (capped at 500 firings, oldest dropped) is what bounds memory, not " +
        "draining on read. Pass back the returned `lastSeq` as the next call's `since` to get " +
        "only what's arrived since. Returns immediately even with zero new entries — this is " +
        "a poll, not a blocking wait; call it again later rather than expecting it to hang " +
        "until something happens. Listeners don't survive a Vortex restart. Worked example " +
        "(confirmed live) to watch new/dismissed notifications: vortex_dispatch " +
        'action="onStateChange" args=[["session","notifications"], "__CALLBACK__"], then poll ' +
        "the returned listenerId — a wrong state path (e.g. persistent.notifications, which " +
        "doesn't exist) fails SILENTLY, returning an empty entries array forever rather than " +
        "an error, indistinguishable from 'registered correctly but nothing happened yet' — " +
        "verify your path first with vortex_query path=[...].",
      inputSchema: z.object({
        listenerId: z
          .string()
          .describe("Id returned by the vortex_dispatch call that registered it"),
        since: z
          .number()
          .int()
          .optional()
          .default(0)
          .describe("Only return entries after this seq (e.g. a previous call's lastSeq)"),
      }),
    },
    async ({ listenerId, since }) => ({
      content: [jsonText(control.pollListener(listenerId, since))],
    }),
  );

  server.registerTool(
    "backup_state",
    {
      description:
        "Create a full snapshot of Vortex's settings/persistent/app/user state as a JSON file " +
        "in Vortex's own backup folder (%APPDATA%/vortex/temp/state_backups_full) — the same " +
        "data Vortex's own manual/hourly backups capture, reproduced from the published API " +
        "since the backup function itself isn't exported. Pure read + file write; does not " +
        "touch Vortex's live state. CONFIG/METADATA ONLY: profile definitions, per-mod " +
        "enabled state, load order (nested under persistent, not a top-level key despite " +
        "'persistent' sounding generic), categories, download records — NOT the mod files " +
        "or archives themselves; this alone can't recover deleted mod content, only Vortex's " +
        "record of what was installed/enabled/ordered. There's no matching restore tool " +
        "exposed here — restoring from this file is a manual step via Vortex's own Settings " +
        "> Workarounds UI outside this MCP server's reach.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe("Label included in the backup filename; defaults to 'mcp'"),
      }),
    },
    async ({ name }) => {
      const backupPath = await control.backupState(api, name);
      return { content: [{ type: "text", text: `Backup written to ${backupPath}` }] };
    },
  );

  server.registerTool(
    "set_mods_enabled",
    {
      description:
        "Enable or disable a set of mods for a profile (defaults to the active profile). Does " +
        "not deploy. Pass expectedActiveProfileId to guard against acting on a stale " +
        "assumption about what's currently active, especially relevant when profileId is " +
        "omitted (defaults to whatever's active right now, which may not be what you last " +
        "observed) — see its own param description.",
      inputSchema: z.object({
        modIds: z.array(z.string()).min(1),
        enabled: z.boolean(),
        profileId: z.string().optional(),
        expectedActiveProfileId: expectedContextSchema.expectedActiveProfileId,
      }),
    },
    async ({ modIds, enabled, profileId, expectedActiveProfileId }) => {
      await control.setModsEnabled(api, modIds, enabled, profileId, {
        activeProfileId: expectedActiveProfileId,
      });
      return {
        content: [
          { type: "text", text: `${enabled ? "Enabled" : "Disabled"} ${modIds.length} mod(s)` },
        ],
      };
    },
  );

  server.registerTool(
    "launch_game",
    {
      description:
        "Launch a game's configured primary tool (e.g. SKSE, or the vanilla exe if none " +
        "is set) — the same operation as Vortex's own 'Play' button, including its " +
        "suggestDeploy check, which can surface a blocking dialog (see list_dialogs/" +
        "vortex_dispatch's closeDialog) if files changed outside Vortex since the last " +
        "deploy. Throws if the game has no primary tool configured.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        expectedActiveGameId: expectedContextSchema.expectedActiveGameId,
      }),
    },
    async ({ gameId, expectedActiveGameId }) => {
      const launched = await control.launchGame(api, gameId, {
        activeGameId: expectedActiveGameId,
      });
      // Name the executable: which one runs depends on the profile's primary
      // tool and on whether that tool's path still exists, and "Launched
      // fallout4" hides both. This reports that the process was *started* —
      // a launcher-style tool exits immediately by design, so it is not a
      // claim that anything is still running.
      return {
        content: [{ type: "text", text: `Started ${launched} for ${gameId ?? "the active game"}` }],
      };
    },
  );

  server.registerTool(
    "vortex_restart",
    {
      description:
        "Restart Vortex via its own graceful relaunch (same path as Vortex's 'Restart now' " +
        "button): closes windows and lets Vortex's normal shutdown sequence finish — " +
        "finalizing in-progress operations, flushing its database — before actually quitting. " +
        "Not a hard process kill. The MCP connection drops during restart and this server " +
        "reconnects automatically once Vortex is back up.",
      inputSchema: z.object({}),
    },
    async () => {
      // Respond before relaunching so the client sees this call succeed — win.close()
      // in Vortex's main process is asynchronous, but give the HTTP response a moment
      // to flush before triggering it regardless.
      setTimeout(() => control.restartVortex(), 200);
      return { content: [{ type: "text", text: "Restarting Vortex..." }] };
    },
  );

  server.registerTool(
    "vortex_quit",
    {
      description:
        "Quit Vortex cleanly — the same path as clicking the window's close button, NOT a " +
        "process kill. The renderer flushes its pending state diffs and main waits for it to " +
        "release its file handles before quitting, which is what leaves the state database " +
        "consistent on disk. Use this rather than killing the process whenever the on-disk " +
        "state matters afterwards (snapshotting a profile, reusing the user-data directory for " +
        "a later run): a hard kill can leave state half-written, and that surfaces later as a " +
        "stale or corrupt profile rather than as an error here. The MCP connection drops and " +
        "does not come back — unlike vortex_restart, nothing restarts it.",
      inputSchema: z.object({}),
    },
    async () => {
      // Respond before quitting so the caller sees this call succeed rather than
      // a dropped connection.
      setTimeout(() => {
        void control.quitVortex();
      }, 200);
      return { content: [{ type: "text", text: "Quitting Vortex cleanly..." }] };
    },
  );

  registerUiWriteTools(server, api);
}

// ---------------------------------------------------------------------------
// UI automation tools
// ---------------------------------------------------------------------------

// Shared target shape for every tool that acts on one element. `ref` is the
// normal path (it comes straight out of ui_snapshot and survives virtualised
// list recycling via the generation check); `selector` is the escape hatch for
// something a snapshot pruned, and for stable hooks like [data-testid].
const uiTargetSchema = {
  ref: z
    .string()
    .optional()
    .describe(
      "Element ref from the most recent ui_snapshot (e.g. 'e42'). Refs are invalidated by the " +
        "next ui_snapshot — a stale one throws rather than silently resolving to a different " +
        "element, which matters because Vortex's mod/plugin tables are virtualised and recycle " +
        "rows as they scroll.",
    ),
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector, as an alternative to `ref`. Prefer [data-testid=...] where one exists; " +
        "Vortex's class names are largely generated and not stable across builds.",
    ),
};

/**
 * Read-only UI tools. These observe the renderer without changing it, so they
 * follow the same no-token-needed rule as every other read tool here.
 */
function registerUiReadTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);

  server.registerTool(
    "ui_snapshot",
    {
      description:
        "Read what is actually ON SCREEN in Vortex right now, as a compact accessibility tree " +
        "with a stable `ref` per node — the primary 'look at the UI' call, and the one that " +
        "hands out the refs every ui_click/ui_fill/ui_hover consumes. Complements, rather than " +
        "replaces, the state tools: vortex_query/list_mods tell you what Vortex BELIEVES, " +
        "ui_snapshot tells you what it is SHOWING, and the two genuinely disagree (a pending " +
        "render, a mod hidden by an active filter, a modal covering the page). Layout wrappers " +
        "with no role, name, test id or own text are collapsed into their children, so the tree " +
        "describes controls rather than React's div soup. Hidden elements are excluded by " +
        "default. Any open modal's text is ALSO surfaced at the top level as `activeDialogs` — " +
        "check it first when a click appears to do nothing, since a modal is the most common " +
        "reason. Every call allocates a new ref generation and invalidates the previous one.",
      inputSchema: z.object({
        selector: z
          .string()
          .optional()
          .describe("Snapshot only within this CSS selector. Defaults to the whole document body."),
        index: z
          .number()
          .int()
          .optional()
          .describe(
            "Which match of `selector` to snapshot when it matches several, 0-based. Defaults to 0. " +
              "Needed for stacked modals: CSS `:nth-of-type()` cannot select between them.",
          ),
        includeHidden: z
          .boolean()
          .optional()
          .describe("Include elements that are present but not visible. Defaults to false."),
        maxDepth: z.number().int().optional().describe("Maximum tree depth. Defaults to 25."),
        maxNodes: z
          .number()
          .int()
          .optional()
          .describe("Stop after this many nodes and set `truncated`. Defaults to 1500."),
        includeBox: z
          .boolean()
          .optional()
          .describe(
            "Include each node's bounding box. Off by default — roughly doubles the response " +
              "size; turn it on when reasoning about layout or overlap.",
          ),
      }),
    },
    async ({ selector, index, includeHidden, maxDepth, maxNodes, includeBox }) => ({
      content: [
        jsonText(ui.snapshot({ selector, index, includeHidden, maxDepth, maxNodes, includeBox })),
      ],
    }),
  );

  server.registerTool(
    "ui_wait_for",
    {
      description:
        "Poll until a CSS selector or a piece of visible text reaches the given state, then " +
        "return how long it took. Use this instead of guessing at sleeps after an action that " +
        "kicks off real work — installing a mod, deploying, switching profile — all of which " +
        "take wildly variable wall-clock time. Returns `matched: false` on timeout rather than " +
        "throwing, so a caller can branch on it; a timeout is not by itself an error, since " +
        "'the notification never appeared' is sometimes the expected outcome.",
      inputSchema: z.object({
        selector: z.string().optional().describe("CSS selector to wait for."),
        text: z
          .string()
          .optional()
          .describe(
            "Substring of the document's visible text to wait for. Use instead of selector.",
          ),
        state: z
          .enum(["visible", "hidden", "attached", "detached"])
          .optional()
          .describe("State to wait for. Defaults to 'visible'."),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe("Give up after this long. Defaults to 10000."),
        pollMs: z.number().int().optional().describe("Poll interval. Defaults to 100."),
      }),
    },
    async ({ selector, text, state, timeoutMs, pollMs }) => ({
      content: [jsonText(await ui.waitFor({ selector, text, state, timeoutMs, pollMs }))],
    }),
  );

  server.registerTool(
    "ui_get_viewport",
    {
      description:
        "Report the Electron window's outer size, the renderer's inner (CSS px) size, and the " +
        "device pixel ratio. The two sizes differ by the window chrome, so compare layout " +
        "findings against `inner`, not `window`.",
      inputSchema: z.object({}),
    },
    async () => ({ content: [jsonText(await ui.getViewport())] }),
  );

  server.registerTool(
    "ui_detect_layout_issues",
    {
      description:
        "Scan the rendered UI at its CURRENT size for responsive-layout breakage: content " +
        "overflowing the right edge, elements pushed fully offscreen, text clipped by an " +
        "overflow:hidden box with no way to scroll to it, and interactive targets that shrank " +
        "below 24px. Heuristic and purely advisory — it reports, it never fails. A horizontal " +
        "scrollbar on a deliberately-scrollable pane is normal and will show up here, so the " +
        "caller decides what counts as a regression; the useful signal is a DIFFERENCE between " +
        "two widths, which is what ui_responsive_sweep automates. Each issue carries a " +
        "descriptive selector so it can be re-examined with ui_snapshot.",
      inputSchema: z.object({
        maxIssues: z.number().int().optional().describe("Cap the issue list. Defaults to 60."),
      }),
    },
    async ({ maxIssues }) => ({ content: [jsonText(ui.detectLayoutIssues({ maxIssues }))] }),
  );

  server.registerTool(
    "ui_read_console",
    {
      description:
        "Read the renderer's console output and uncaught errors/rejections from an in-process " +
        "ring buffer (500 entries, oldest dropped), captured since this extension loaded. This " +
        "is the only way to see a React render error or a failed fetch over MCP: DevTools is " +
        "not reachable from here, and Vortex's own log file only carries what Vortex explicitly " +
        "logs, not what the browser runtime reports. Non-destructive — pass the returned " +
        "`lastSeq` back as `since` to get only what is new. `dropped: true` means the buffer " +
        "wrapped and entries were lost between your last poll and this one.",
      inputSchema: z.object({
        since: z.number().int().optional().describe("Only return entries after this seq."),
        levels: z
          .array(z.enum(["log", "info", "warn", "error", "debug"]))
          .optional()
          .describe("Filter to these levels. Omit for all."),
        limit: z.number().int().optional().describe("Max entries returned. Defaults to 200."),
      }),
    },
    async ({ since, levels, limit }) => ({
      content: [jsonText(ui.readConsole({ since, levels, limit }))],
    }),
  );
}

/**
 * UI tools that change something — click, type, resize, reload.
 *
 * Write-tier for the same reason the Redux write tools are: these drive the
 * user's real, logged-in Vortex. A click here can start a download, delete a mod
 * or launch a game, so it sits behind the same VORTEX_MCP_TOKEN gate rather than
 * being treated as harmless because it "only" moves a mouse. Resizing is in this
 * tier too: it visibly moves the window of whoever is sitting in front of it.
 */
function registerUiWriteTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);

  server.registerTool(
    "ui_click",
    {
      description:
        "Click an element, addressed by `ref` from ui_snapshot or by CSS `selector`. Dispatches " +
        "a full pointer/mouse sequence (pointerdown, mousedown, focus, pointerup, mouseup, " +
        "click) rather than HTMLElement.click(), because several Vortex widgets — dropdown " +
        "toggles, table row selection — listen on mousedown and ignore a bare click event. " +
        "Refuses to click an invisible or disabled element with an explanatory error instead of " +
        "silently doing nothing; pass requireActionable=false to force it anyway. Scrolls the " +
        "element into view first. This performs a REAL action in a REAL Vortex: it can start " +
        "downloads, remove mods, or launch a game.",
      inputSchema: z.object({
        ...uiTargetSchema,
        button: z.enum(["left", "right", "middle"]).optional().describe("Defaults to 'left'."),
        clickCount: z.number().int().optional().describe("2 for a double-click. Defaults to 1."),
        modifiers: z
          .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
          .optional()
          .describe("Modifier keys held during the click (e.g. ['Control'] for multi-select)."),
        requireActionable: z
          .boolean()
          .optional()
          .describe(
            "Throw when the element is hidden or disabled. Defaults to true — turning it off " +
              "is for deliberately testing that a disabled control does nothing.",
          ),
      }),
    },
    async (args) => ({ content: [jsonText(ui.click(args))] }),
  );

  server.registerTool(
    "ui_fill",
    {
      description:
        "Set the value of an <input>, <textarea> or contenteditable, then fire input+change so " +
        "React's onChange actually runs. Uses the prototype's native value setter first: " +
        "assigning `.value` directly updates the DOM but leaves React's internal value tracker " +
        "stale, so React swallows the event and the component never updates — the classic " +
        "'typed into the box but nothing happened' failure. Replaces the existing value rather " +
        "than appending. For a <select> use ui_select_option; for a button use ui_click.",
      inputSchema: z.object({
        ...uiTargetSchema,
        value: z.string().describe("The full new value (replaces whatever is there)."),
      }),
    },
    async (args) => ({ content: [jsonText(ui.fill(args))] }),
  );

  server.registerTool(
    "ui_press_key",
    {
      description:
        "Dispatch a keydown/keypress/keyup on a target element, or on whatever currently has " +
        "focus when no target is given. Use for Escape (dismiss a Vortex modal), Enter (submit " +
        "a search/filter), Tab, and arrow-key navigation. Note this dispatches DOM key events " +
        "only — it does not drive the OS-level keyboard, so it will not reach a native menu or " +
        "an OS file-picker dialog.",
      inputSchema: z.object({
        ...uiTargetSchema,
        key: z
          .string()
          .describe("Key value, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', or a single char."),
        modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
      }),
    },
    async (args) => ({ content: [jsonText(ui.pressKey(args))] }),
  );

  server.registerTool(
    "ui_hover",
    {
      description:
        "Move the pointer over an element, firing the pointerover/mouseover/mouseenter sequence. " +
        "Needed before clicking controls that appear on hover, where a JS handler (React's " +
        "onMouseEnter and friends) is what reveals them. IMPORTANT LIMIT: this dispatches DOM " +
        "events, which do NOT change the browser's own hover state, so a control revealed purely " +
        "by a CSS `:hover` rule stays hidden — only a real mouse move can do that, and nothing " +
        "in the renderer can produce one. Vortex's game tiles are exactly this case: the " +
        "'Manage' button sits in a `.hover-content` wrapper at opacity 0, so after ui_hover it " +
        "is still correctly reported as hidden. Two ways through: click it anyway with " +
        "ui_click + requireActionable=false (the handler fires regardless of opacity), or use " +
        "the harness's `realHover`, which drives a real mouse over CDP.",
      inputSchema: z.object(uiTargetSchema),
    },
    async (args) => ({ content: [jsonText(ui.hover(args))] }),
  );

  server.registerTool(
    "ui_select_option",
    {
      description:
        "Choose an option in a native <select>, by `value` or by visible `label`, firing " +
        "input+change. Lists every available option in the error when nothing matches, so a " +
        "failed guess immediately tells you what the valid choices were. Does NOT work on " +
        "Vortex's custom React dropdowns, which are not <select> elements — drive those with " +
        "ui_click on the toggle, then ui_click on the revealed item.",
      inputSchema: z.object({
        ...uiTargetSchema,
        value: z.string().optional().describe("Option value attribute to select."),
        label: z
          .string()
          .optional()
          .describe("Visible option text to select. Use instead of value."),
      }),
    },
    async (args) => ({ content: [jsonText(ui.selectOption(args))] }),
  );

  server.registerTool(
    "ui_scroll",
    {
      description:
        "Scroll the window, or a specific scrollable element when given a ref/selector. Also " +
        "dispatches a scroll event, which is what makes Vortex's virtualised tables actually " +
        "mount the newly-revealed rows — without it the rows stay absent from the DOM and a " +
        "following ui_snapshot still cannot see them.",
      inputSchema: z.object({
        ...uiTargetSchema,
        deltaX: z.number().optional().describe("Horizontal pixels; positive scrolls right."),
        deltaY: z.number().optional().describe("Vertical pixels; positive scrolls down."),
      }),
    },
    async (args) => ({ content: [jsonText(ui.scroll(args))] }),
  );

  server.registerTool(
    "ui_set_viewport",
    {
      description:
        "Resize the real Electron window to test responsive layout. Unmaximises first, because " +
        "setSize on a maximised window is silently ignored on Windows — without that, every " +
        "size in a sweep reports the same maximised dimensions and the results are meaningless. " +
        "Returns both the requested and the ACTUAL resulting size: the OS enforces the window's " +
        "minimum, so a request below it is clamped, and comparing the two is how you tell. " +
        "This moves the window of whoever is sitting in front of Vortex.",
      inputSchema: z.object({
        width: z.number().int().describe("Target outer window width in px."),
        height: z.number().int().describe("Target outer window height in px."),
      }),
    },
    async ({ width, height }) => ({
      content: [jsonText(await ui.setViewport({ width, height }))],
    }),
  );

  server.registerTool(
    "ui_responsive_sweep",
    {
      description:
        "Resize through a list of viewports, running the ui_detect_layout_issues scan at each, " +
        "then restore the original size — the restore runs even if the sweep fails partway, so " +
        "it cannot strand the user's window at 1024x720. Defaults to 1024x720, 1280x800, " +
        "1600x900 and 1920x1080. Read the results as a DIFF across sizes rather than as pass/" +
        "fail: an issue present at every width is usually a pre-existing quirk, while one that " +
        "appears only below a threshold is the actual responsive regression. Structure only: an " +
        "extension cannot screenshot (capturePage is main-process only), so for images at each " +
        "size use the harness's `vortex-ai responsive --screenshots`, which captures over CDP.",
      inputSchema: z.object({
        viewports: z
          .array(z.object({ width: z.number().int(), height: z.number().int() }))
          .optional()
          .describe("Sizes to test, in order. Defaults to the four standard ones."),
        settleMs: z
          .number()
          .int()
          .optional()
          .describe("Wait after each resize before scanning, for re-layout. Defaults to 400."),
        maxIssuesPerViewport: z.number().int().optional().describe("Defaults to 25."),
      }),
    },
    async ({ viewports, settleMs, maxIssuesPerViewport }) => ({
      content: [jsonText(await ui.responsiveSweep({ viewports, settleMs, maxIssuesPerViewport }))],
    }),
  );

  server.registerTool(
    "ui_reload_renderer",
    {
      description:
        "Reload the renderer window, picking up a rebuilt renderer bundle WITHOUT restarting " +
        "Electron — the hot-reload path after editing renderer code. Much cheaper than " +
        "vortex_restart: the main process, and so the open state database, survives. Does NOT " +
        "pick up a change to MAIN-process code (nothing in the renderer can reload main) — use " +
        "vortex_restart for that. All ui_snapshot refs are invalidated; take a fresh snapshot " +
        "after the reload settles. The MCP connection drops briefly while the renderer tears " +
        "down and this extension re-registers.",
      inputSchema: z.object({}),
    },
    async () => {
      ui.reloadRenderer();
      return {
        content: [
          {
            type: "text",
            text:
              "Reloading the renderer. Wait ~2-5s, then ui_wait_for a known element before " +
              "taking a fresh ui_snapshot — all previous refs are now invalid.",
          },
        ],
      };
    },
  );
}

function isTokenAuthorized(req: http.IncomingMessage): boolean {
  if (TOKEN === undefined) {
    return true;
  }
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function createToolServer(api: IExtensionApi): McpServer {
  const server = new McpServer({ name: "vortex-mcp", version: "0.1.0" });
  registerReadTools(server, api);
  // Fail closed: writes (profile switch, mod enable/disable, deploy, purge, install,
  // game activation) are only ever registered — let alone reachable — when an operator
  // has explicitly opted in by setting a token. No token means no write tool exists to call.
  if (TOKEN !== undefined) {
    registerWriteTools(server, api);
  }
  return server;
}

export function startMcpServer(api: IExtensionApi): http.Server {
  if (TOKEN === undefined)
    log("warn", "[vortex-mcp] VORTEX_MCP_TOKEN not set — write tools disabled, read-only mode");

  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }

    if (!isTokenAuthorized(req)) {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    // A Protocol owns one transport. Sharing it across HTTP requests can route
    // a late-arriving request body onto a newer client's transport and shares
    // cancellation state between clients using the same JSON-RPC ids.
    const server = createToolServer(api);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => {
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log("error", "[vortex-mcp] request failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log("warn", "[vortex-mcp] port already in use, assuming a prior instance is running", {
        port: PORT,
      });
      return;
    }
    log("error", "[vortex-mcp] HTTP server error", { message: err.message });
  });

  httpServer.listen(PORT, HOST, () => {
    log("info", "[vortex-mcp] MCP server listening", { url: `http://${HOST}:${PORT}/mcp` });
  });

  return httpServer;
}
