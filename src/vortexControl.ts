import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";

import { actions, selectors, util, fs, log, types } from "@nexusmods/vortex-api";

const execFileAsync = promisify(execFile);

type IExtensionApi = types.IExtensionApi;
type IMod = types.IMod;
type IProfile = types.IProfile;

// Not part of @nexusmods/vortex-api — window.api is Vortex's own Electron preload
// bridge (contextBridge), reachable because this extension shares the renderer
// process. Unlike vortex-api this isn't a published contract Nexus Mods commits to
// keeping stable; it can change across Vortex releases without warning.
declare const window: {
  api?: {
    app?: { relaunch: (args?: string[]) => void };
    window?: { getId: () => Promise<number>; close: (windowId: number) => Promise<void> };
  };
};

/**
 * Restarts Vortex via its own graceful relaunch path (the same one behind Vortex's
 * "Restart now" button): closes windows and lets Vortex's normal shutdown sequence
 * (finalize in-progress operations, flush its database) run before actually quitting.
 * Not a hard process kill.
 */
export function restartVortex(): void {
  const relaunch = window.api?.app?.relaunch;
  if (relaunch === undefined) {
    throw new Error("window.api.app.relaunch is unavailable (unexpected Vortex preload shape)");
  }
  relaunch();
}

/**
 * Quits Vortex the same way clicking the window's close button does.
 *
 * Closing the window (rather than calling app.exit) is what makes this a *clean*
 * shutdown: Vortex's close handler notifies the renderer, which synchronously
 * flushes its pending state diffs, and main then waits for the renderer to
 * release its file handles before quitting. app.exit skips all of that and can
 * leave the state database half-written — which shows up later as a corrupt or
 * stale profile rather than as an error here.
 */
export async function quitVortex(): Promise<void> {
  const windowApi = window.api?.window;
  if (windowApi === undefined) {
    throw new Error("window.api.window is unavailable (unexpected Vortex preload shape)");
  }
  await windowApi.close(await windowApi.getId());
}

// Matches store.ts's FULL_BACKUP_PATH constant (not exported from @nexusmods/vortex-api),
// so a backup taken here lands in the same folder as Vortex's own manual/hourly backups.
const FULL_BACKUP_PATH = "state_backups_full";

/**
 * Writes a full snapshot of Vortex's settings/persistent/app/user state to Vortex's own
 * backup folder, reproducing store.ts's createFullStateBackup (not exported from
 * @nexusmods/vortex-api) from public pieces only: no session/extension persistors, no
 * credentials — the same fields Vortex's own backup captures.
 */
export async function backupState(api: IExtensionApi, name = "mcp"): Promise<string> {
  const st = state(api) as unknown as Record<string, unknown>;
  const backup = {
    settings: st.settings,
    persistent: st.persistent,
    app: st.app,
    user: st.user,
  };
  const serialized = JSON.stringify(backup, undefined, 2);

  const basePath = path.join(util.getVortexPath("userData"), "temp", FULL_BACKUP_PATH);
  const backupFilePath = path.join(basePath, `${name}-${Date.now()}.json`);

  await fs.ensureDirWritableAsync(basePath, () => Promise.resolve());
  await util.writeFileAtomic(backupFilePath, serialized);

  log("info", "[vortex-mcp] state backup created", {
    path: backupFilePath,
    size: serialized.length,
  });
  return backupFilePath;
}

export interface ModSummary {
  id: string;
  name: string;
  type: string;
  version?: string;
  /**
   * Whether Vortex's profile state has this MOD enabled. A mod can ship multiple plugin
   * files (esp/esm/esl) and enabling the mod does not mean every plugin it ships is
   * active in the load order — see findMissingDeployedFiles' vortexEnabled for the
   * per-plugin equivalent, which can legitimately disagree with this field.
   */
  enabled: boolean;
}

function state(api: IExtensionApi): types.IState {
  if (api.store === undefined) {
    throw new Error("Vortex store not initialized yet");
  }
  return api.store.getState() as types.IState;
}

function store(api: IExtensionApi) {
  if (api.store === undefined) {
    throw new Error("Vortex store not initialized yet");
  }
  return api.store;
}

/**
 * Resolves a caller-supplied gameId (falling back to the active game) and validates it
 * against Vortex's own known-games catalog. Found live: without the validation half, a
 * typo'd gameId (e.g. a game that was never installed, or a misspelling) silently
 * produced an empty result from every read tool that scopes to a game — indistinguishable
 * from "this game genuinely has nothing installed for it" — rather than a clear error.
 */
function resolveGameId(gameId: string | undefined, st: types.IState): string {
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const known = selectors.knownGames(st) as { id: string }[];
  if (!known.some((g) => g.id === targetGameId)) {
    throw new Error(
      `Unknown gameId: "${targetGameId}" — not in Vortex's known-games catalog. Query ` +
        'vortex_query({selector: "discovered"}) for games Vortex has actually found ' +
        "installed.",
    );
  }
  return targetGameId;
}

export interface ExpectedContext {
  /** Throw unless this is still the active profile id. */
  activeProfileId?: string;
  /** Throw unless this is still the active game id. */
  activeGameId?: string;
}

/**
 * Guards a write against acting on a silently-changed context. Found live (a real
 * cold-run incident, not a hypothetical): switching to a 1000+ mod profile, then doing
 * ~20 minutes of read-only analysis assuming it stayed active, only to discover the
 * active profile had reverted to a completely different one partway through — with zero
 * error, zero notification, from any of this project's tools. Vortex's own log showed a
 * plain "profile change" entry with no record of what triggered it (the user's own UI, a
 * health-check side effect, anything) — this project's tools can't distinguish "I caused
 * this" from "something else did" and shouldn't try to. What they CAN do is let a caller
 * who captured activeProfileId/activeGameId earlier assert it's still true immediately
 * before a write, so a stale assumption fails loudly instead of silently mutating the
 * wrong profile/game. Both fields are optional and independent; omit either to skip that
 * check. This is opt-in, not a default gate — a caller that never captured the context
 * (or doesn't care) pays no cost and gets no protection, same tradeoff this project's
 * reflection-first tools always make.
 */
function assertExpectedContext(api: IExtensionApi, expected: ExpectedContext | undefined): void {
  if (expected === undefined) {
    return;
  }
  const st = state(api);
  if (expected.activeProfileId !== undefined) {
    const actual = selectors.activeProfileId(st) as string | undefined;
    if (actual !== expected.activeProfileId) {
      throw new Error(
        `Active profile changed since you last checked: expected "${expected.activeProfileId}" ` +
          `but "${actual ?? "(none)"}" is active now — something else (the user's own Vortex ` +
          "UI, another agent, a health check) switched it. Re-verify with list_profiles before " +
          "retrying; don't assume your original target is still correct.",
      );
    }
  }
  if (expected.activeGameId !== undefined) {
    const actual = selectors.activeGameId(st) as string | undefined;
    if (actual !== expected.activeGameId) {
      throw new Error(
        `Active game changed since you last checked: expected "${expected.activeGameId}" but ` +
          `"${actual ?? "(none)"}" is active now. Re-verify with list_profiles or ` +
          'vortex_query({selector: "activeGameId"}) before retrying.',
      );
    }
  }
}

export interface ApiDescription {
  /** Names callable via query({ selector, args }) — each is (state, ...args) => value. */
  selectors: string[];
  /**
   * Notes for the selectors this project has verified are easy to reach for and get
   * wrong — same "documentation, not a gate" role as dispatchHints. A selector missing
   * here is still fully callable; you just don't get a pre-verified caveat.
   */
  selectorHints: Record<string, string>;
  /**
   * All of Vortex's action-creator names — every one of these is dispatchable via
   * vortex_dispatch. The loopback bind + bearer token is the actual security boundary
   * (matches what a human at Vortex's own UI can already do); there is no further
   * per-action allowlist on top of that.
   */
  actions: string[];
  /**
   * Real positional argument order for the actions this project has bothered to verify
   * against Vortex's own source/behavior, e.g. "gameId: string, modId: string" — pure
   * documentation to save you a source-read, not a list of what's callable (see `actions`
   * for that — everything there works). An action missing here still dispatches fine;
   * you just don't get a pre-verified argument order.
   */
  dispatchHints: Record<string, string>;
  /** Top-level keys of the Redux state tree, walkable via query({ path }). */
  stateKeys: string[];
  /**
   * Names extensions have exposed via context.registerAPI (api.ext.<name>) — Vortex core's
   * own (Nexus/Mods/Downloads helpers) plus any third-party extension that does the same.
   * All of these are callable via vortex_dispatch too (same token boundary as `actions`) —
   * arbitrary signatures, so there's no uniform arg format to validate against, but nothing
   * here is specially blocked.
   */
  extensionApis: string[];
  /** Positional argument order for the extensionApis entries this project has verified — same caveat as dispatchHints. */
  extensionApiHints: Record<string, string>;
  /**
   * Direct method names on the live IExtensionApi instance (api.foo(...)) — distinct
   * from selectors/actions/extensionApis. This is how a real capability gap got found:
   * runExecutable (launching a game/tool) is one of these, not a Redux action or an
   * api.ext export, so nothing in the other three lists would ever surface it. All of
   * these are dispatchable via vortex_dispatch too (same token boundary) — a few are
   * UI-only pickers (selectDir/selectFile/selectExecutable); the ones that register a
   * persistent listener (onStateChange, onAsync, registerProtocol,
   * registerRepositoryLookup) go through a listenerId + poll_listener flow instead of
   * returning a normal result — see listenerHints. withPrePost returns a wrapped
   * function and isn't usefully dispatchable at all (see dispatchAction's error for it).
   */
  apiMethods: string[];
  /**
   * Event names api.events.emit(name, ...args) can trigger, discovered from
   * currently-registered listeners (api.events.eventNames()) rather than hardcoded. All
   * of these are dispatchable via vortex_dispatch too — see eventHints for the
   * CALLBACK_SENTINEL convention needed to await actual completion on the few that use a
   * callback, rather than just firing.
   */
  eventNames: string[];
  /** Positional argument order (incl. CALLBACK_SENTINEL position) for the eventNames entries this project has verified. */
  eventHints: Record<string, string>;
  /**
   * Positional argument order (incl. CALLBACK_SENTINEL position) for the apiMethods that
   * register a persistent listener instead of returning a normal result — dispatching
   * one of these returns { listenerId }; read what it's captured via poll_listener.
   */
  listenerHints: Record<string, string>;
}

export function describeApi(api: IExtensionApi): ApiDescription {
  const st = state(api);
  const apiRecord = api as unknown as Record<string, unknown>;
  return {
    selectors: Object.keys(selectors).toSorted(),
    selectorHints: Object.fromEntries(SELECTOR_HINTS),
    actions: Object.keys(actions).toSorted(),
    dispatchHints: Object.fromEntries(ACTION_HINTS),
    stateKeys: Object.keys(st as object).toSorted(),
    extensionApis: Object.keys(api.ext ?? {}).toSorted(),
    extensionApiHints: Object.fromEntries(EXTENSION_API_HINTS),
    apiMethods: Object.keys(apiRecord)
      .filter((key) => typeof apiRecord[key] === "function")
      .toSorted(),
    eventNames: api.events
      .eventNames()
      .filter((name): name is string => typeof name === "string")
      .toSorted(),
    eventHints: Object.fromEntries(EVENT_HINTS),
    listenerHints: Object.fromEntries(
      Object.entries(LISTENER_SPECS).map(([name, spec]) => [name, spec.hint]),
    ),
  };
}

export function querySelector(api: IExtensionApi, name: string, args: unknown[] = []): unknown {
  const fn = (selectors as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`Unknown selector: ${name}. Call describeApi() for the available list.`);
  }
  return (fn as (...fnArgs: unknown[]) => unknown)(state(api), ...args);
}

export function queryStatePath(api: IExtensionApi, statePath: string[]): unknown {
  let value: unknown = state(api);
  for (const key of statePath) {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// Pure documentation, same "verified subset, not a gate" shape as ACTION_HINTS below —
// a selector missing here still queries fine, you just don't get a pre-verified caveat.
const SELECTOR_HINTS = new Map<string, string>([
  [
    "knownGames",
    "Vortex's full static game catalog (~5000 entries, every game Vortex ships support " +
      "for) — found live to run past 60K characters and blow the response size limit. " +
      'For "what games are actually installed/discovered" (almost always what\'s wanted), ' +
      "use selector='discovered' instead — far smaller, real install paths only.",
  ],
  [
    "profiles",
    "Every profile's FULL per-mod enabled state (id -> IProfile, including modState) — " +
      "found live to run past 800K characters and blow the response size limit, even for " +
      "a single game. Use the list_profiles tool instead for id/name/gameId/active/" +
      "modCount without the full state dump.",
  ],
  [
    "gameProfiles",
    "Despite taking a gameId argument, found live to return the exact same payload " +
      "(byte-identical, confirmed with two different gameId values) regardless of what's " +
      "passed — it does not filter by game. Same size problem as `profiles` on top of " +
      "that. Use the list_profiles tool (which does filter correctly by gameId) instead.",
  ],
  [
    "downloadsForGame",
    "Found live to run past 10M characters for a real download history (900+ entries) — " +
      "blows the response size limit. Use the list_downloads tool instead (formatted, " +
      "filterable by state, and paginated via limit).",
  ],
  [
    "getDownloadByIds",
    "Found live to return null regardless of argument shape tried (a single id array, or " +
      "ids as separate positional args) — could not get this selector working through " +
      "vortex_query. For a specific download's full record, use vortex_query with " +
      'path=["persistent","downloads","files","<id>"] instead — confirmed working live, ' +
      "small payload, includes the installed.modId join key list_downloads' " +
      "installedModId is also drawn from.",
  ],
]);

// NOT an allowlist — every one of Vortex's ~150 action creators is dispatchable via
// vortex_dispatch (see dispatchAction below). This map is pure documentation: the real
// positional argument order (name: type) for the actions this project has actually
// verified, read from @nexusmods/vortex-api's action-creator payload field names — or,
// for the three entries typed `any` there (setLoadOrderEntry/setFBLoadOrder/
// setFBLoadOrderEntry), from their actual definitions in Vortex source
// (mod_load_order/file_based_loadorder). Surfaced via vortex_describe's dispatchHints so
// a caller doesn't need to go read source first for these; an action missing here still
// works via vortex_dispatch, you just don't get a pre-verified argument order.
//
// The security boundary is the loopback bind + bearer token (see mcpServer.ts) — once an
// operator holds the token they already have "full write privileges" per this project's
// own documented model, matching what a human at Vortex's own UI can already do. An
// earlier version of this file gated vortex_dispatch behind this map's key set, excluding
// "admin-level" actions (paths, extensions, credentials) — removed deliberately: it was a
// second, hand-maintained boundary that didn't protect against a meaningfully different
// threat than the token already does, required manual upkeep for every new safe Vortex
// action, and blocked the trusted case (an agent acting on the operator's own behalf) for
// no real gain against an adversarial one (who'd already have full access via the token).
const ACTION_HINTS = new Map<string, string>([
  [
    "type:SET_PLUGIN_ENABLED",
    "args=[{pluginName: string, enabled: boolean}] — a SINGLE OBJECT payload (this is a " +
      "raw type:-prefixed dispatch, not a normal action creator call: no positional " +
      "args, args[0] IS the whole payload). Toggles ONE PLUGIN's (.esp/.esm/.esl) own " +
      "load-order enabled flag directly — distinct from set_mods_enabled, which " +
      "operates on mods, not individual plugins a mod may ship several of (see " +
      "LoadOrderEntry.enabled's own doc comment). Defined inside the gamebryo-plugin-" +
      "management extension (read from its actions/loadOrder.ts + reducers/loadOrder.ts " +
      "source) — confirmed live this does NOT appear in vortex_describe's `actions` " +
      "list at all, unreachable any other way through this project. Only applies to " +
      "games using the gamebryo/LOOT plugin system (list_load_order works or throws the " +
      "same way this does or doesn't apply). Re-check list_load_order afterward — this " +
      "doesn't deploy or update plugins.txt itself.",
  ],
  ["addMod", "gameId: string, mod: IMod"],
  ["addMods", "gameId: string, mods: IMod[]"],
  ["addModRule", "gameId: string, modId: string, rule: IModRule"],
  ["clearModRules", "gameId: string, modId: string"],
  ["removeMod", "gameId: string, modId: string"],
  [
    "removeModRule",
    "gameId: string, modId: string, rule: IModRule " +
      "(must deep-match the stored rule exactly, incl. reducer-added fields like " +
      "reference.idHint that addModRule fills in even if you didn't pass one — " +
      "read the rule back via list_mod_rules/vortex_query first)",
  ],
  ["setModAttribute", "gameId: string, modId: string, attribute: string, value: any"],
  ["setModAttributes", "gameId: string, modId: string, attributes: Record<string, any>"],
  ["setModArchiveId", "gameId: string, modId: string, archiveId: string"],
  ["setModEnabled", "profileId: string, modId: string, enable: boolean"],
  ["setModInstallationPath", "gameId: string, modId: string, installPath: string"],
  ["setModState", "gameId: string, modId: string, modState: ModState"],
  ["setModType", "gameId: string, modId: string, type: string"],
  ["setCategory", "gameId: string, id: string, category: ICategory"],
  [
    "setCategoryOrder",
    "gameId: string, categoryIds: string[] (the full ordered id list, not just the ones " +
      "you're moving — re-numbers every category's `order` field 0-indexed by array " +
      "position on every call. Dispatching the original id list back restores the same " +
      "relative order but not necessarily the original absolute `order` numbers.)",
  ],
  ["removeCategory", "gameId: string, id: string"],
  ["renameCategory", "gameId: string, categoryId: string, name: string"],
  ["loadCategories", "gameId: string, gameCategories: ICategoryDictionary"],
  ["updateCategories", "gameId: string, gameCategories: ICategoryDictionary"],
  ["setFileOverride", "gameId: string, modId: string, files: string[]"],
  ["setINITweakEnabled", "gameId: string, modId: string, tweak: string, enabled: boolean"],
  ["setLoadOrder", "id: string, order: unknown[]"],
  ["setLoadOrderEntry", "profileId: string, modId: string, loEntry: ILoadOrderEntry"],
  ["setFBLoadOrder", "profileId: string, loadOrder: LoadOrder"],
  ["setFBLoadOrderEntry", "profileId: string, loEntry: ILoadOrderEntry"],
  [
    "setPendingPluginSort",
    "profileId: string, collectionId: string, time: number " +
      "(dispatches cleanly but is a no-op unless the Collections extension is active — " +
      "verify the effect actually landed rather than trusting the dispatch response alone)",
  ],
  ["clearPendingPluginSort", "profileId: string"],
  [
    "removeProfile",
    "profileId: string " +
      "(permanently deletes the profile's on-disk directory — no undo. Only ever call " +
      "this on a profile you created yourself, e.g. via clone_profile, for testing.)",
  ],
  ["setActivator", "gameId: string, activatorId: string"],
  ["setAutoDeployment", "deploy: boolean"],
  ["setCleanupOnDeploy", "cleanup: boolean"],
  ["setConfirmPurge", "confirm: boolean"],
  ["setDeploymentNecessary", "gameId: string, required: boolean"],
  ["setDownloadModInfo", "id: string, key: string, value: any"],
  ["setDownloadHash", "id: string, fileMD5: string"],
  ["mergeDownloadModInfo", "id: string, value: any"],
  ["pauseDownload", "id: string, paused: boolean"],
  ["removeDownload", "id: string"],
  ["removeDownloadSilent", "id: string"],
  ["setDownloadInstalled", "id: string, gameId: string, modId: string"],
  ["setDownloadInterrupted", "id: string, realReceived: number"],
  [
    "closeDialog",
    "id: string, actionKey?: string, input?: unknown " +
      "(actionKey must be one of the dialog's own `actions` labels — read via list_dialogs " +
      "first, never guess; input is only meaningful for a dialog with checkboxes/input " +
      "fields, e.g. { checkbox-id: true } or { input-id: 'value' })",
  ],
  [
    "closeDialogs",
    "ids: string[], actionKey?: string, input?: unknown (same semantics as closeDialog, " +
      "applied to multiple dialogs at once)",
  ],
  [
    "showDialog",
    "type: 'success'|'info'|'error'|'question', title: string, content: IDialogContent " +
      "(e.g. { message: 'text' }), actions: {label: string, default?: boolean}[], id?: string",
  ],
]);

// Positional args for an event dispatched through the `events` fallback below can
// include this literal string at the exact position where Vortex's own event handler
// expects a Node-style (err, result?) callback — e.g. api.events.emit("deploy-mods", cb).
// dispatchAction replaces it with a real callback and returns a promise that resolves/
// rejects with whatever that callback receives, so the caller actually waits for
// completion instead of just firing the event. Omit it entirely for a fire-and-forget
// event (most of them — no callback convention at all).
const CALLBACK_SENTINEL = "__CALLBACK__";

// Real positional argument order (including the exact CALLBACK_SENTINEL position, for
// the ones that use it) for the events this project has verified — same "documentation,
// not a gate" role as ACTION_HINTS/EXTENSION_API_HINTS. Confirmed by what deploy_mods/
// purge_mods/install_mod_from_url/activate_game (removed as dedicated tools once this
// generic mechanism could fully express them) used to call directly.
const EVENT_HINTS = new Map<string, string>([
  [
    "deploy-mods",
    '"__CALLBACK__" — no other args. Resolves once deployment actually finishes ' +
      "(not just once it started).",
  ],
  [
    "purge-mods",
    'allowFallback: boolean, "__CALLBACK__" — resolves once the purge actually finishes.',
  ],
  [
    "start-download",
    'urls: string[] (e.g. ["nxm://..."]), modInfo: object (e.g. {}), unused: null, ' +
      '"__CALLBACK__" — resolves to the new download id. Can trigger a blocking ' +
      '"choose install type" modal for ambiguous archives if the caller doesn\'t await ' +
      "completion carefully — see list_dialogs/closeDialog.",
  ],
  [
    "activate-game",
    "gameId: string — fire-and-forget, no callback (omit the sentinel entirely). Vortex " +
      "validates the id itself; an unknown gameId silently no-ops rather than throwing.",
  ],
  [
    "autosort-plugins",
    'force: boolean, "__CALLBACK__" (optional — read from Vortex source, ' +
      "gamebryo-plugin-management/src/index.ts and PluginList.tsx: some call sites omit " +
      "the callback entirely for fire-and-forget). Runs a LOOT sort on the ACTIVE " +
      "profile's plugin list (no profileId/gameId arg — there's no way to target a " +
      "non-active profile). force=true re-sorts even if Vortex thinks nothing changed; " +
      "force=false honors the user's auto-sort setting and may no-op. Re-check " +
      "list_load_order afterward to see the result — this event doesn't return the new " +
      "order itself even via the callback (callback only reports err).",
  ],
]);

async function dispatchEvent(api: IExtensionApi, name: string, args: unknown[]): Promise<unknown> {
  const callbackIndex = args.indexOf(CALLBACK_SENTINEL);
  if (callbackIndex === -1) {
    api.events.emit(name, ...args);
    return { emitted: name };
  }
  return new Promise((resolve, reject) => {
    const realArgs = [...args];
    realArgs[callbackIndex] = (err: unknown, result?: unknown) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } else {
        resolve(result);
      }
    };
    api.events.emit(name, ...realArgs);
  });
}

// A handful of apiMethods don't perform an action — they register a real JS function as
// a persistent listener (fires repeatedly, for the life of the Vortex process; none of
// these expose a way to unregister). A function can't cross JSON-RPC, so — same
// CALLBACK_SENTINEL convention as events — dispatchAction substitutes a real callback
// that appends each firing to an in-process ring buffer and returns a listenerId
// immediately, rather than trying to wait for or return "the result" of something that
// keeps happening. Poll accumulated firings via poll_listener. `returns` is what the
// substituted callback itself must hand back to satisfy the real API's contract (most
// want nothing back; registerRepositoryLookup's callback must resolve to a lookup
// result array, so ours always resolves empty since we're only capturing args here).
const LISTENER_SPECS: Record<
  string,
  { returns: "void" | "promiseUndefined" | "promiseArray"; hint: string }
> = {
  onStateChange: {
    returns: "void",
    hint: 'path: string[], "__CALLBACK__" — fires with (previous, current) on every change to the given state path.',
  },
  onAsync: {
    returns: "promiseUndefined",
    hint: 'eventName: string, "__CALLBACK__" — fires with the event\'s own args each time eventName is emitted via emitAndAwait.',
  },
  registerProtocol: {
    returns: "void",
    hint: 'protocol: string, def: boolean, "__CALLBACK__" — fires with (url, install) when this protocol (e.g. an nxm:// link) is invoked.',
  },
  registerRepositoryLookup: {
    returns: "promiseArray",
    hint:
      'repositoryId: string, preferOverMD5: boolean, "__CALLBACK__" — fires with the lookup id ' +
      "when Vortex needs mod metadata for this repository; the real API expects the callback to " +
      "resolve to lookup results, so ours always resolves [] (only args are captured here).",
  },
};

const MAX_CONCURRENT_LISTENERS = 20;
const MAX_BUFFER_ENTRIES_PER_LISTENER = 500;

interface ListenerEntry {
  seq: number;
  args: unknown[];
  receivedAt: number;
}

interface ListenerRecord {
  name: string;
  buffer: ListenerEntry[];
  nextSeq: number;
}

// Module-level, not per-request: the MCP transport is stateless (no session tied to a
// connection), but this extension runs inside Vortex's own long-lived process, so state
// here survives across separate tool calls just fine — that's what makes register-then-
// poll possible at all.
const listeners = new Map<string, ListenerRecord>();

function registerListener(
  api: IExtensionApi,
  name: string,
  args: unknown[],
): { listenerId: string } {
  const spec = LISTENER_SPECS[name];
  const callbackIndex = args.indexOf(CALLBACK_SENTINEL);
  if (callbackIndex === -1) {
    throw new Error(
      `${name} registers a persistent listener and needs the "__CALLBACK__" sentinel in args ` +
        "at the callback position — see vortex_describe's listenerHints.",
    );
  }
  if (listeners.size >= MAX_CONCURRENT_LISTENERS) {
    throw new Error(
      `Too many active listeners (${MAX_CONCURRENT_LISTENERS} max) — none of these apiMethods ` +
        "support unregistering, so restart Vortex to clear them before registering more.",
    );
  }

  const listenerId = crypto.randomUUID();
  const record: ListenerRecord = { name, buffer: [], nextSeq: 1 };
  listeners.set(listenerId, record);

  const callback = (...callArgs: unknown[]): unknown => {
    record.buffer.push({ seq: record.nextSeq++, args: callArgs, receivedAt: Date.now() });
    if (record.buffer.length > MAX_BUFFER_ENTRIES_PER_LISTENER) {
      record.buffer.shift();
    }
    switch (spec.returns) {
      case "promiseUndefined":
        return Promise.resolve(undefined);
      case "promiseArray":
        return Promise.resolve([]);
      default:
        return undefined;
    }
  };

  const realArgs = [...args];
  realArgs[callbackIndex] = callback;

  const apiFn = (api as unknown as Record<string, unknown>)[name];
  (apiFn as (...fnArgs: unknown[]) => unknown).apply(api, realArgs);

  return { listenerId };
}

/**
 * Reads back what a listener registered via dispatchAction has captured since `since`
 * (a previously-returned `lastSeq`, or 0 for everything still buffered). Non-destructive
 * — repeated polling with the same `since` returns the same entries — the ring buffer
 * itself is what bounds memory, not draining on read.
 */
export function pollListener(
  listenerId: string,
  since = 0,
): { entries: ListenerEntry[]; lastSeq: number } {
  const record = listeners.get(listenerId);
  if (record === undefined) {
    throw new Error(
      `Unknown listenerId: ${listenerId}. It may have never existed, or Vortex restarted — ` +
        "listeners don't survive a restart.",
    );
  }
  const entries = record.buffer.filter((entry) => entry.seq > since);
  return { entries, lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : since };
}

/**
 * Dispatches a named Vortex action creator, api.ext function, event, or direct api
 * method — checked in that order. Not allowlisted: everything vortex_describe reflects
 * is reachable this way, once the caller holds the write-tier bearer token (see
 * ACTION_HINTS's comment for why that token, not a second curated list, is the actual
 * security boundary). Events need the CALLBACK_SENTINEL convention to await actual
 * completion rather than just firing; the small set of apiMethods in LISTENER_SPECS use
 * the same convention to register a persistent listener instead (see registerListener).
 */
// Found live: many real, meaningful actions (e.g. gamebryo-plugin-management's
// setPluginEnabled, the actual per-PLUGIN enable/disable toggle distinct from mod-level
// set_mods_enabled — confirmed live it does NOT appear in vortex_describe's `actions`
// list at all) are defined inside a game-extension's own module, not re-exported through
// @nexusmods/vortex-api's published `actions` object — the ENTIRE surface the first
// dispatch path below can reach. There's no api.ext/event/apiMethod path to them either.
// This prefix is an explicit, deliberate escape hatch: dispatch a raw {type, payload}
// Redux action by its literal type string once you already know it (read the
// extension's own actions/*.ts and reducers/*.ts source, matching how ACTION_HINTS
// entries prefixed with this get verified) — bypasses the "must be a published creator
// function" requirement entirely. Deliberately NOT a silent fallback for an unrecognized
// action name (that would turn a typo into a silent no-op instead of a clear error,
// since most reducers just ignore an unknown type) — requires this explicit prefix so a
// caller is unambiguously opting in, not accidentally triggering it.
const RAW_ACTION_TYPE_PREFIX = "type:";

export interface PayloadShape {
  /**
   * Best-effort recovered payload shape: maps each payload object key to the positional
   * index of the creator's own argument it comes from, e.g. {pluginName: 0, enabled: 1}
   * for a creator declared `(pluginName, enabled) => ({pluginName, enabled})`. Empty when
   * `passthroughPayload`/`noPayload` is true, or when the creator's shape didn't match a
   * recognized pattern (still report the type string alone in that case — a bare type
   * with unknown shape is still more than nothing, and callers can tell the two apart
   * from `noPayload`/`passthroughPayload` both being false).
   */
  payloadKeys: Record<string, number>;
  /**
   * True when the creator takes a single argument used directly as the whole payload
   * (no wrapping object), e.g. `pluginName => pluginName` — dispatch with
   * args=[thatValueDirectly], matching how the RAW_ACTION_TYPE_PREFIX path already
   * treats args[0] as the whole payload.
   */
  passthroughPayload: boolean;
  /**
   * True when createAction was called with no second argument at all (redux-act's
   * no-payload form, e.g. `createAction('CLEAR_USERLIST')`) — a fully CONFIRMED shape,
   * not an unrecognized one: dispatch with args=[] (no payload). Distinct from both
   * `payloadKeys` being empty for an unrecognized shape and from `passthroughPayload`
   * (which still takes one real argument).
   */
  noPayload: boolean;
}

export interface DiscoveredAction extends PayloadShape {
  /** The literal Redux action type string — use with vortex_dispatch as action="type:<this>". */
  type: string;
  /** Extension directory name this was found in — provenance only, not guaranteed stable across Vortex releases. */
  extension: string;
}

// Found live (verified on a real installed Vortex, not guessed): every bundled extension
// ships its compiled JS unpacked on disk (util.getVortexPath("bundledPlugins") resolves
// this correctly across platforms/packaging — NOT hardcoded to a Program Files path), and
// user-installed/third-party extensions live under <userData>/plugins the same way
// vortex-mcp itself does. Both are plain files readable via fs, no app.asar archive
// parsing needed. This makes every dispatchable extension-internal action mechanically
// discoverable at runtime on ANY real installation — not just one with Vortex's
// TypeScript source checked out — which is the whole point: RAW_ACTION_TYPE_PREFIX
// dispatch needs a type string (and ideally a payload shape) from *somewhere*, and this
// is that somewhere, without hand-curating a growing list into this project's own source.
function extensionScanRoots(): string[] {
  const roots = [util.getVortexPath("bundledPlugins")];
  const userPluginsDir = path.join(util.getVortexPath("userData"), "plugins");
  if (!roots.includes(userPluginsDir)) {
    roots.push(userPluginsDir);
  }
  return roots;
}

// redux-act's createAction(TYPE, prepareFn) is called through Rollup's CJS-interop
// wrapper in these bundles — literally `(0,g.createAction)(...)`, confirmed live — so a
// plain substring search for "createAction" followed by "walk forward to the next '('"
// finds the real call's argument list regardless of whether that "(" is immediately
// adjacent or preceded by the interop wrapper's closing ")".
function findMatchingParenEnd(text: string, openParenIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString !== null) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// Splits `text` on top-level commas only — not ones nested inside (), [], {}, or a
// string literal. Used both for a call's argument list and an object literal's entries.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString !== null) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const QUOTED_STRING = /^(["'`])((?:\\.|(?!\1).)*)\1$/;

const NO_PAYLOAD_SHAPE: PayloadShape = {
  payloadKeys: {},
  passthroughPayload: false,
  noPayload: true,
};
const UNRECOGNIZED_SHAPE: PayloadShape = {
  payloadKeys: {},
  passthroughPayload: false,
  noPayload: false,
};

// Extracts {key: paramIndex} from an object literal's inner text (no surrounding braces),
// resolving each entry's value against the creator's own parameter list. Shared by both
// the direct-return and null-guarded-ternary shapes in parsePrepareFnShape below.
function extractPayloadKeysFromObjectBody(
  objectBody: string,
  paramIndex: Map<string, number>,
): Record<string, number> {
  const payloadKeys: Record<string, number> = {};
  for (const entry of splitTopLevel(objectBody)) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) {
      // shorthand { key } -- key and value are the same identifier
      const idx = paramIndex.get(entry.trim());
      if (idx !== undefined) {
        payloadKeys[entry.trim()] = idx;
      }
      continue;
    }
    const key = entry.slice(0, colonIdx).trim();
    const value = entry.slice(colonIdx + 1).trim();
    const idx = paramIndex.get(value);
    if (idx !== undefined) {
      payloadKeys[key] = idx;
    }
  }
  return payloadKeys;
}

/**
 * Recovers a PayloadShape from a prepare-function's source text, when its shape matches
 * a recognized pattern. An unrecognized shape returns UNRECOGNIZED_SHAPE — still leaves
 * the type string itself usable.
 */
function parsePrepareFnShape(fnText: string): PayloadShape {
  const arrowSplit = /^\(?([^)=]*)\)?\s*=>\s*([\s\S]*)$/.exec(fnText);
  if (arrowSplit === null) {
    return UNRECOGNIZED_SHAPE;
  }
  const params = splitTopLevel(arrowSplit[1]).filter((p) => p.length > 0);
  const paramIndex = new Map(params.map((p, idx) => [p, idx]));
  let body = arrowSplit[2].trim();

  // Strip an `undefined`-check ternary wrapper before matching the object-literal case
  // below -- found live (SET_EDIT_MOD_CYCLE): the real recoverable shape is the ternary's
  // else-branch, the guard just means the creator also tolerates being called with its
  // first argument undefined (there's nothing meaningful to record about that in
  // PayloadShape; the else-branch shape is what matters for a real call). Matches both
  // operand orders and both undefined spellings a minifier or a hand-written creator
  // might produce: `x === void 0 ? void 0 : rest`, `void 0 === x ? void 0 : rest`, and
  // the `== null` / `undefined` variants.
  const ID = "[a-zA-Z_$][\\w$]*";
  const UNDEF = "(?:void 0|undefined)";
  const guardMatch = new RegExp(
    `^(?:${ID}\\s*===?\\s*${UNDEF}|${UNDEF}\\s*===?\\s*${ID}|${ID}\\s*==\\s*null)` +
      `\\s*\\?\\s*${UNDEF}\\s*:\\s*([\\s\\S]*)$`,
  ).exec(body);
  if (guardMatch) {
    body = guardMatch[1].trim();
  }

  // ({key: a, other: b, ...}) for a direct arrow return (parens required by JS there),
  // or {key: a, ...} with no parens, which is what's left after stripping a ternary
  // guard above (a ternary branch doesn't need parens to disambiguate an object literal).
  const objectMatch = /^\(?\{([\s\S]*)\}\)?$/.exec(body);
  if (objectMatch) {
    return {
      payloadKeys: extractPayloadKeysFromObjectBody(objectMatch[1], paramIndex),
      passthroughPayload: false,
      noPayload: false,
    };
  }
  // bare single-identifier passthrough: a => a  (payload IS that one argument)
  if (params.length === 1 && body === params[0]) {
    return { payloadKeys: {}, passthroughPayload: true, noPayload: false };
  }
  return UNRECOGNIZED_SHAPE;
}

function scanFileForActions(text: string, extensionName: string): DiscoveredAction[] {
  const results: DiscoveredAction[] = [];
  const seenTypes = new Set<string>();
  let searchFrom = 0;
  while (true) {
    const markerIdx = text.indexOf("createAction", searchFrom);
    if (markerIdx === -1) {
      break;
    }
    searchFrom = markerIdx + "createAction".length;
    const openParenIdx = text.indexOf("(", searchFrom);
    if (openParenIdx === -1 || openParenIdx - searchFrom > 5) {
      // Not immediately followed by a call (allowing a few chars for the ")(" interop
      // pattern) -- this occurrence is something else (e.g. a comment, an import name).
      continue;
    }
    const closeParenIdx = findMatchingParenEnd(text, openParenIdx);
    if (closeParenIdx === -1) {
      continue;
    }
    const argsText = text.slice(openParenIdx + 1, closeParenIdx);
    const [typeArg, prepareArg] = splitTopLevel(argsText);
    if (typeArg === undefined) {
      continue;
    }
    const typeMatch = QUOTED_STRING.exec(typeArg);
    if (typeMatch === null) {
      // First arg isn't a plain string literal (could be a computed/variable type in
      // rare cases) -- skip rather than report a bogus type.
      continue;
    }
    const type = typeMatch[2];
    if (seenTypes.has(type)) {
      continue;
    }
    seenTypes.add(type);
    const shape = prepareArg !== undefined ? parsePrepareFnShape(prepareArg) : NO_PAYLOAD_SHAPE;
    results.push({ type, extension: extensionName, ...shape });
  }
  return results;
}

let cachedDiscoveredActions: DiscoveredAction[] | undefined;

/**
 * Scans every installed extension's compiled JS (bundled + user-installed, both plain
 * files on disk — see extensionScanRoots) for redux-act createAction(TYPE, prepareFn)
 * call sites, recovering the real dispatchable action type string and, where the
 * prepare-function's shape is recognizable, its payload structure — without needing
 * Vortex's TypeScript source checked out anywhere. This is what makes
 * RAW_ACTION_TYPE_PREFIX ("type:") dispatch discoverable on an arbitrary real
 * installation instead of only for the handful of cases this project happened to
 * hand-document by reading source. Recovers SHAPE only, not reducer BEHAVIOR — confirmed
 * live two ways: gamebryo-plugin-management's TOGGLE_TUTORIAL silently ignores its own
 * `isOpen` payload value unless `tutorialId` matches the currently-open one (ground truth
 * needs a real dispatch + state read, not just this scan), while that same extension's
 * userlist-family actions (setGroup and siblings) all match plugin names case-
 * insensitively, confirmed by dispatching a wrong-case pluginId live and observing it
 * correctly update the existing entry rather than creating a duplicate. Cached for the
 * process lifetime (these files only change when Vortex/an extension updates) — pass
 * forceRefresh to re-scan.
 */
export async function scanExtensionActions(
  api: IExtensionApi,
  forceRefresh = false,
): Promise<DiscoveredAction[]> {
  if (!forceRefresh && cachedDiscoveredActions !== undefined) {
    return cachedDiscoveredActions;
  }
  // extensionScanRoots() is ordered bundled-first, user-plugins-last, which is also
  // Vortex's own load precedence for a same-name extension in both locations (a
  // user-installed update shadows the bundled copy). Keyed by extensionName so a later
  // root's actions for that name replace an earlier root's, instead of both ending up in
  // the result as an unresolvable duplicate.
  const byExtension = new Map<string, DiscoveredAction[]>();
  for (const root of extensionScanRoots()) {
    let extensionDirs: string[];
    try {
      extensionDirs = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue; // root doesn't exist on this install (e.g. no user-installed extensions yet)
    }
    for (const extensionName of extensionDirs) {
      // Found live: entry filename isn't uniform across this install — 62 of 132
      // bundled extensions ship index.cjs, the other 70 ship index.js, and (bigger
      // impact) EVERY user-installed/third-party extension on this machine uses
      // index.js exclusively, none use .cjs. Checking only one name was silently
      // skipping the entire third-party extension ecosystem (confirmed live: a
      // Starfield extension alone had 6 real createAction sites this missed). No
      // "main" field in info.json to consult instead — these two names are it.
      let text: string | undefined;
      for (const entryName of ["index.cjs", "index.js"]) {
        try {
          text = await readFile(path.join(root, extensionName, entryName), "utf8");
          break;
        } catch {
          continue;
        }
      }
      if (text === undefined) {
        continue; // neither entry filename exists here -- not a JS-bundled extension
      }
      byExtension.set(extensionName, scanFileForActions(text, extensionName));
    }
  }
  const results = [...byExtension.values()].flat();
  cachedDiscoveredActions = results;
  return results;
}

export async function dispatchAction(
  api: IExtensionApi,
  name: string,
  args: unknown[] = [],
  expectedContext?: ExpectedContext,
): Promise<unknown> {
  assertExpectedContext(api, expectedContext);
  if (name.startsWith(RAW_ACTION_TYPE_PREFIX)) {
    const rawType = name.slice(RAW_ACTION_TYPE_PREFIX.length);
    store(api).dispatch({ type: rawType, payload: args[0] });
    return { dispatched: rawType, raw: true };
  }
  const fn = (actions as Record<string, unknown>)[name];
  if (typeof fn === "function") {
    const result = (fn as (...fnArgs: unknown[]) => unknown)(...args);
    // Most actions are plain redux-act action creators returning {type, payload}. A few
    // (closeDialog, closeDialogs, showDialog) are thunks — plain functions taking
    // (dispatch, getState) — since Vortex uses redux-thunk middleware, dispatching the
    // function itself (not a {type} object) is the correct call; there's no natural
    // {type, payload} to report back for these, so the response just confirms what ran.
    if (typeof result === "function") {
      store(api).dispatch(result as (...fnArgs: unknown[]) => unknown);
      return { dispatched: name, thunk: true };
    }
    if (
      result === null ||
      typeof result !== "object" ||
      typeof (result as { type?: unknown }).type !== "string"
    ) {
      throw new Error(`${name} did not return a dispatchable action object.`);
    }
    store(api).dispatch(result as { type: string });
    return result;
  }

  const extFn = ((api.ext ?? {}) as unknown as Record<string, unknown>)[name];
  if (typeof extFn === "function") {
    return (extFn as (...fnArgs: unknown[]) => unknown)(...args);
  }

  if (api.events.eventNames().includes(name)) {
    return dispatchEvent(api, name, args);
  }

  if (name in LISTENER_SPECS) {
    return registerListener(api, name, args);
  }

  if (name === "withPrePost") {
    throw new Error(
      "withPrePost returns a wrapped function rather than performing an action or " +
        "registering a listener — it can't be usefully dispatched over MCP (the returned " +
        "function isn't JSON-serializable, and nothing happens until it's invoked, which " +
        "this dispatcher never does).",
    );
  }

  const apiFn = (api as unknown as Record<string, unknown>)[name];
  if (typeof apiFn === "function") {
    return (apiFn as (...fnArgs: unknown[]) => unknown).apply(api, args);
  }

  throw new Error(
    `Unknown action, api.ext function, event, or api method: ${name}. Check vortex_describe's ` +
      "actions/extensionApis/eventNames/apiMethods lists.",
  );
}

export function switchProfile(
  api: IExtensionApi,
  profileId: string,
  expectedContext?: ExpectedContext,
): void {
  assertExpectedContext(api, expectedContext);
  const st = state(api);
  if (selectors.profiles(st)[profileId] === undefined) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  store(api).dispatch(actions.setNextProfile(profileId));
}

export interface ProfileSummary {
  id: string;
  name: string;
  gameId: string;
  active: boolean;
  modCount: number;
  enabledModCount: number;
  lastActivated: number;
}

function summarizeProfile(profile: IProfile, activeProfileId: string | undefined): ProfileSummary {
  const modStates = Object.values(profile.modState ?? {});
  return {
    id: profile.id,
    name: profile.name,
    gameId: profile.gameId,
    active: profile.id === activeProfileId,
    modCount: modStates.length,
    enabledModCount: modStates.filter((m) => m.enabled).length,
    lastActivated: profile.lastActivated,
  };
}

/**
 * Lists profiles (defaults to every game; pass gameId to filter to one) with name,
 * active status, and mod counts — the join vortex_query can't do in one call without
 * dumping the full per-profile modState (persistent.profiles.<id> can run past 500K
 * characters for a large modlist, found live). Sorted most-recently-activated first.
 */
export function listProfiles(api: IExtensionApi, gameId?: string): ProfileSummary[] {
  const st = state(api);
  const activeProfileId = selectors.activeProfileId(st);
  const all = Object.values(selectors.profiles(st)) as IProfile[];
  return all
    .filter((p) => p.pendingRemove !== true)
    .filter((p) => gameId === undefined || p.gameId === gameId)
    .map((p) => summarizeProfile(p, activeProfileId))
    .toSorted((a, b) => b.lastActivated - a.lastActivated);
}

// Mirrors profile_management/util/manage.ts's profilePath — not exported from
// @nexusmods/vortex-api, so reconstructed from the (exported) getVortexPath helper.
function profilePath(profile: IProfile): string {
  return path.join(util.getVortexPath("userData"), profile.gameId, "profiles", profile.id);
}

/**
 * Clones an existing profile: copies its on-disk profile directory (load order,
 * ini tweaks, etc.) to a new profile id, then registers the new profile — the
 * same two steps Vortex's own "Clone" button performs (ProfileView.tsx's
 * onCloneProfile). The source profile is only ever read, never modified.
 */
export async function cloneProfile(
  api: IExtensionApi,
  sourceProfileId: string,
  name?: string,
): Promise<ProfileSummary> {
  const st = state(api);
  const source = selectors.profiles(st)[sourceProfileId];
  if (source === undefined) {
    throw new Error(`Unknown profile: ${sourceProfileId}`);
  }

  const newProfile: IProfile = {
    ...source,
    id: crypto.randomBytes(6).toString("base64url"),
    name: name ?? `${source.name} (clone)`,
  };

  await fs.ensureDirAsync(profilePath(source));
  await fs.copyAsync(profilePath(source), profilePath(newProfile));
  store(api).dispatch(actions.setProfile(newProfile));

  return summarizeProfile(newProfile, selectors.activeProfileId(st));
}

export interface ListModsOptions {
  /** Only include mods currently enabled for the profile. Default false (all mods). */
  enabledOnly?: boolean;
  /** Case-insensitive substring match against the rendered mod name. */
  nameFilter?: string;
  /** Cap the number of results (applied after filtering). Default unlimited. */
  limit?: number;
}

export function listMods(
  api: IExtensionApi,
  gameId?: string,
  options: ListModsOptions = {},
): ModSummary[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const profile = selectors.activeProfile(st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const nameFilterLower = options.nameFilter?.toLowerCase();

  const summaries = Object.values(mods)
    .map((mod) => ({
      id: mod.id,
      name: util.renderModName(mod),
      type: mod.type,
      version: mod.attributes?.version as string | undefined,
      enabled:
        profile?.gameId === targetGameId ? (profile?.modState?.[mod.id]?.enabled ?? false) : false,
    }))
    .filter((mod) => !options.enabledOnly || mod.enabled)
    .filter(
      (mod) => nameFilterLower === undefined || mod.name.toLowerCase().includes(nameFilterLower),
    );

  return options.limit !== undefined ? summaries.slice(0, options.limit) : summaries;
}

export interface CategorySummary {
  id: string;
  name: string;
  order: number;
  parentCategory?: string;
  modCount: number;
}

/**
 * Lists a game's mod categories with a mod count per category — a join
 * state.persistent.categories[gameId] alone can't do, same reasoning as list_mods.
 */
export function listCategories(api: IExtensionApi, gameId?: string): CategorySummary[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const categories =
    (queryStatePath(api, ["persistent", "categories", targetGameId]) as
      | Record<string, { name: string; order: number; parentCategory?: string }>
      | undefined) ?? {};
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const modCounts = new Map<string, number>();
  for (const mod of Object.values(mods)) {
    const category = mod.attributes?.category;
    if (category === undefined) {
      continue;
    }
    const key = String(category);
    modCounts.set(key, (modCounts.get(key) ?? 0) + 1);
  }

  return Object.entries(categories)
    .map(([id, cat]) => ({
      id,
      name: cat.name,
      order: cat.order,
      parentCategory: cat.parentCategory,
      modCount: modCounts.get(id) ?? 0,
    }))
    .toSorted((a, b) => a.order - b.order);
}

export interface LoadOrderEntry {
  plugin: string;
  index: number;
  /**
   * Whether this specific PLUGIN is active in the load order — a separate concept from a
   * MOD's enabled state (see ModSummary.enabled). A mod can be enabled while one of the
   * plugins it ships is toggled off here (see DeploymentDiscrepancy.vortexEnabled, the
   * same underlying flag): toggling a mod on/off does not necessarily toggle every plugin
   * it ships, and set_mods_enabled operates on mods, not individual plugins.
   */
  enabled: boolean;
}

/**
 * Reads the current Gamebryo/LOOT plugin load order from state.loadOrder — a top-level
 * key added at runtime by the gamebryo-plugin-management extension, not present in
 * @nexusmods/vortex-api's published IState (discovered live via vortex_describe, not
 * from the type declarations). Games using file_based_loadorder instead (no .esp/.esm
 * plugins) won't have this key; this throws rather than silently returning nothing.
 */
export function listLoadOrder(api: IExtensionApi): LoadOrderEntry[] {
  const raw = queryStatePath(api, ["loadOrder"]) as
    | Record<string, { loadOrder: number; enabled?: boolean }>
    | undefined;
  if (raw === undefined || Object.keys(raw).length === 0) {
    throw new Error(
      "No plugin load order available (state.loadOrder is empty or missing) — this game may " +
        "use a different load-order system (e.g. file_based_loadorder), or none is active.",
    );
  }
  return Object.entries(raw)
    .map(([plugin, entry]) => ({ plugin, index: entry.loadOrder, enabled: entry.enabled ?? true }))
    .toSorted((a, b) => a.index - b.index);
}

export interface PluginDetail {
  plugin: string;
  /** -1 when the plugin has no load-order entry at all (not deployed/known). */
  index: number;
  enabled: boolean;
  /** Mod id this plugin came from, when known (from session.plugins.pluginList). */
  modId?: string;
  deployed?: boolean;
  /** True for a hard-coded engine plugin Vortex has no ordering influence over. */
  isNative?: boolean;
  /** LOOT group this plugin is assigned to, when LOOT metadata was fetched successfully. */
  group?: string;
  version?: string;
  /**
   * Raw LOOT messages (warnings/errors from the LOOT masterlist) for this plugin, when
   * fetched successfully. Shape comes straight from the `loot` native package — this
   * project doesn't vendor its types, so treat entries as opaque and read fields as
   * found rather than assuming a schema.
   */
  messages?: unknown[];
  /** True when LOOT reports dirty edits (ITM/UDR) for this plugin. */
  dirty?: boolean;
}

// load order and session.plugins.pluginList both live at a single global (active-game)
// state path with no per-game keying — there's no way to read either for a non-active
// game, so a gameId that doesn't match the active one is rejected rather than silently
// merging that game's LOOT data with the active game's load order/plugin records.
const MAX_PLUGIN_DETAILS_BATCH = 25;
const PLUGIN_DETAILS_TIMEOUT_MS = 30_000;

/**
 * Fetches the same rich per-plugin info Vortex's own Plugins tab shows — master list,
 * LOOT messages/warnings, dirty-edit status, group, version — by triggering the SAME
 * real LOOT lookup (event "plugin-details") the UI panel and lootSortAsync both use
 * under the hood, then merging it with load order (index/enabled) and the base record
 * already cached in session.plugins.pluginList (modId, deployed, isNative). NOT safely
 * reachable via vortex_dispatch's generic CALLBACK_SENTINEL mechanism: confirmed live
 * that "plugin-details"'s real callback signature is (result) => void — a SINGLE
 * argument — not the (err, result?) convention that mechanism assumes; using it
 * generically silently misinterprets the real result object as an error (surfaced as a
 * baffling "[object Object]" failure with no other explanation). This function talks to
 * the event directly with the correct single-argument contract instead. Capped at
 * MAX_PLUGIN_DETAILS_BATCH plugins and PLUGIN_DETAILS_TIMEOUT_MS per call — a real,
 * potentially slow LOOT call (loads the current load order, may hit the LOOT
 * masterlist) — pass a subset and make repeat calls for a full modlist.
 */
export async function getPluginDetails(
  api: IExtensionApi,
  pluginNames: string[],
  gameId?: string,
): Promise<PluginDetail[]> {
  if (pluginNames.length > MAX_PLUGIN_DETAILS_BATCH) {
    throw new Error(
      `Requested ${pluginNames.length} plugins, max ${MAX_PLUGIN_DETAILS_BATCH} per call ` +
        "— split into multiple calls.",
    );
  }
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const activeGameId = selectors.activeGameId(st);
  if (targetGameId !== activeGameId) {
    throw new Error(
      `getPluginDetails only supports the active game (${String(activeGameId)}) — load ` +
        `order and plugin state have no per-game storage for an inactive game. Switch ` +
        `profile/game to "${targetGameId}" first.`,
    );
  }
  const loadOrder = listLoadOrder(api);
  const loadOrderByPlugin = new Map(loadOrder.map((entry) => [entry.plugin.toLowerCase(), entry]));
  const pluginList =
    (queryStatePath(api, ["session", "plugins", "pluginList"]) as
      | Record<string, { modId?: string; deployed?: boolean; isNative?: boolean }>
      | undefined) ?? {};

  type LootPluginInfo = {
    messages?: unknown[];
    dirtyness?: unknown[];
    group?: string;
    version?: string;
  };
  if (api.events.listenerCount("plugin-details") === 0) {
    throw new Error(
      'No listener registered for the "plugin-details" event — the extension that ' +
        "provides plugin details (e.g. gamebryo-plugin-management) isn't loaded for " +
        `"${targetGameId}".`,
    );
  }
  const lootInfo = await new Promise<Record<string, LootPluginInfo>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for "plugin-details" after ${PLUGIN_DETAILS_TIMEOUT_MS}ms`),
      );
    }, PLUGIN_DETAILS_TIMEOUT_MS);
    try {
      api.events.emit("plugin-details", targetGameId, pluginNames, (result: unknown) => {
        clearTimeout(timer);
        resolve((result ?? {}) as Record<string, LootPluginInfo>);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return pluginNames.map((plugin) => {
    const lower = plugin.toLowerCase();
    const lo = loadOrderByPlugin.get(lower);
    const base = pluginList[plugin] ?? pluginList[lower];
    const loot = lootInfo[plugin] ?? lootInfo[lower];
    return {
      plugin,
      index: lo?.index ?? -1,
      enabled: lo?.enabled ?? false,
      modId: base?.modId,
      deployed: base?.deployed,
      isNative: base?.isNative,
      group: loot?.group,
      version: loot?.version,
      messages: loot?.messages,
      dirty: (loot?.dirtyness?.length ?? 0) > 0,
    };
  });
}

export async function setModsEnabled(
  api: IExtensionApi,
  modIds: string[],
  enabled: boolean,
  profileId?: string,
  expectedContext?: ExpectedContext,
): Promise<void> {
  assertExpectedContext(api, expectedContext);
  const st = state(api);
  const targetProfileId = profileId ?? selectors.activeProfileId(st);
  if (!targetProfileId) {
    throw new Error("No active profile and no profileId provided");
  }
  await actions.setModsEnabled(api, targetProfileId, modIds, enabled);
}

interface DiscoveredTool {
  path: string;
  parameters?: string[];
  workingDirectory?: string;
  shell?: boolean;
  detach?: boolean;
}

/**
 * Launches a game's configured primary tool (e.g. SKSE for Skyrim, or the vanilla exe
 * if no script extender is set) via api.runExecutable — the one genuinely missing piece
 * of standard Vortex usage this server didn't cover, because runExecutable is a direct
 * IExtensionApi method (found via vortex_describe's apiMethods, not a Redux action or an
 * emitted event — nothing else in the reflected surface would have shown it).
 *
 * The primary-tool resolution (settings.interface.primaryTool[gameId] ->
 * settings.gameMode.discovered[gameId].tools[toolId]) was found the same way this
 * project always resolves an undocumented state shape: by reading real live state,
 * not guessing from types — there's no selector that does this lookup for us.
 * suggestDeploy: true mirrors Vortex's own "Play" button, which is what actually
 * surfaces the "files changed outside Vortex" prompt list_dialogs/closeDialog exist for.
 */
/** Returns the executable actually launched, which is not always the one asked for. */
export interface LaunchOptions extends ExpectedContext {
  /**
   * How long to wait for the game's process to appear before deciding the
   * primary tool started nothing. Exposed so tests need not wait it out.
   */
  processWaitMs?: number;
}

export async function launchGame(
  api: IExtensionApi,
  gameId?: string,
  expectedContext?: LaunchOptions,
): Promise<string> {
  assertExpectedContext(api, expectedContext);
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);

  const discovery = queryStatePath(api, ["settings", "gameMode", "discovered", targetGameId]) as
    | { path?: string; executable?: string }
    | undefined;

  // Clearing a primary tool leaves `null` in the state rather than removing the
  // key, so an `!== undefined` check treats "no primary tool" as a tool named
  // "null" and refuses to launch anything — instead of falling back to the
  // game's own executable, which is exactly what clearing it asks for.
  const primaryTool = queryStatePath(api, [
    "settings",
    "interface",
    "primaryTool",
    targetGameId,
  ]) as string | null | undefined;
  const toolId = primaryTool === null || primaryTool === "" ? undefined : primaryTool;

  if (toolId !== undefined) {
    const tool = queryStatePath(api, [
      "settings",
      "gameMode",
      "discovered",
      targetGameId,
      "tools",
      toolId,
    ]) as DiscoveredTool | undefined;
    if (tool === undefined) {
      throw new Error(`Primary tool '${toolId}' for ${targetGameId} is not in discovered tools.`);
    }
    // A recorded tool can outlive the file it points at: profiles carry their
    // tools with them, so a seeded or restored instance routinely names a path
    // that no longer exists. Vortex spawns it regardless, the process dies at
    // once, and the launch "succeeds" — so an unusable tool is worse than none.
    // Prefer the game's own executable in that case rather than launching a
    // path that cannot work.
    if (await executableMissing(tool.path)) {
      log("warn", "[vortex-mcp] primary tool is missing; falling back to the game executable", {
        gameId: targetGameId,
        toolId,
        path: tool.path,
      });
    } else {
      await api.runExecutable(tool.path, tool.parameters ?? [], {
        cwd: tool.workingDirectory,
        shell: tool.shell ?? false,
        detach: tool.detach ?? true,
        suggestDeploy: true,
      });

      // Spawning the tool proves nothing about whether the game started. A
      // loader-style tool exits as soon as it has handed off, so the tool's own
      // process is not the thing to watch — and a stale one (a backup F4SE
      // built for another game version, say) exits the same way having started
      // nothing. Both look identical from here, so watch for the *game*.
      const gameExe = resolveGameExecutable(api, targetGameId, discovery ?? {});
      const started =
        gameExe === undefined ||
        (await waitForProcess(path.basename(gameExe), expectedContext?.processWaitMs));
      if (started) {
        log("info", "[vortex-mcp] launched game", {
          gameId: targetGameId,
          toolId,
          path: tool.path,
        });
        return tool.path;
      }
      log(
        "warn",
        "[vortex-mcp] primary tool started nothing; falling back to the game executable",
        {
          gameId: targetGameId,
          toolId,
          path: tool.path,
        },
      );
    }
  }

  // No primary tool: fall back to the game's own executable, which is what
  // Vortex's Play button does and what this tool's description has always
  // promised ("or the vanilla exe if none is set"). Throwing instead meant
  // "launch the game" failed on any profile where nobody had picked a tool —
  // which is most of them, and every freshly-managed game.
  // Only the fallback needs the install path — a primary tool carries its own
  // absolute path and can live anywhere.
  if (discovery?.path === undefined) {
    throw new Error(
      `${targetGameId} has no primary tool configured and no discovered install path, ` +
        `so there is nothing to launch.`,
    );
  }

  const executable = resolveGameExecutable(api, targetGameId, discovery);
  if (executable === undefined) {
    throw new Error(
      `No primary tool is configured for ${targetGameId} and its executable could not be ` +
        `determined from the game extension. Set a primary tool in Vortex's Tools page.`,
    );
  }

  const fullPath = path.isAbsolute(executable) ? executable : path.join(discovery.path, executable);
  await api.runExecutable(fullPath, [], {
    cwd: path.dirname(fullPath),
    shell: false,
    detach: true,
    suggestDeploy: true,
  });
  log("info", "[vortex-mcp] launched game executable", {
    gameId: targetGameId,
    path: fullPath,
  });
  return fullPath;
}

/**
 * Whether a recorded executable no longer exists.
 *
 * Treats an unreadable path as missing: the question being asked is "can this be
 * launched", and anything that cannot be stat'd cannot.
 */
/**
 * Wait for a process with this image name to appear.
 *
 * Deliberately a poll on the OS process list rather than anything Vortex
 * tracks: Vortex records the PID of the tool it spawned, which for a loader is
 * a process that is *supposed* to be gone moments later.
 *
 * A false positive is possible — the game may already have been running — and
 * is the right way to be wrong: it means "do not launch a second copy".
 */
async function waitForProcess(imageName: string, timeoutMs: number = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await processRunning(imageName)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function processRunning(imageName: string): Promise<boolean> {
  const [command, args] =
    process.platform === "win32"
      ? (["tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/NH"]] as const)
      : (["pgrep", ["-x", imageName]] as const);
  try {
    const { stdout } = await execFileAsync(command, [...args], { windowsHide: true });
    return stdout.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    // pgrep exits non-zero when nothing matches, which is an answer, not a fault.
    return false;
  }
}

async function executableMissing(executablePath: string): Promise<boolean> {
  try {
    await stat(executablePath);
    return false;
  } catch {
    return true;
  }
}

/**
 * The game's own executable, preferring what discovery recorded over what the
 * extension declares: a user who relocated or renamed the binary is recorded
 * there and nowhere else.
 */
function resolveGameExecutable(
  api: IExtensionApi,
  gameId: string,
  discovery: { executable?: string },
): string | undefined {
  if (discovery.executable !== undefined && discovery.executable !== "") {
    return discovery.executable;
  }

  const known = selectors.knownGames(state(api)) as {
    id: string;
    executable?: string;
    requiredFiles?: string[];
  }[];
  const game = known.find((g) => g.id === gameId);
  if (game?.executable !== undefined && game.executable !== "") return game.executable;

  // Last resort: an extension that declares no executable almost always lists
  // the binary among the files it requires to consider the game installed.
  return game?.requiredFiles?.[0];
}

export interface DownloadSummary {
  id: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  startTime: number;
  /**
   * The mod id this download is recorded as installed as, when set. Found live: this is
   * the only reliable download-to-mod join key — matching by name is fragile (Nexus
   * display names and installed mod names commonly diverge) and can be stale (Vortex
   * updates a mod in place under the same modId, so an OLDER download of the same mod can
   * still carry this pointer even though a newer download is what's actually deployed —
   * don't treat this alone as proof the download's exact file content is currently live).
   */
  installedModId?: string;
}

export interface ListDownloadsOptions {
  /**
   * Only include downloads in one of these states ("init"/"started"/"paused"/
   * "finalizing"/"finished"/"failed"/"redirect"). Default: every state except
   * "finished" — found live that an unfiltered dump of a real download history
   * (932 entries, 921 of them long-finished) blows the response size limit;
   * what's actually being asked for is almost always "what's active/stuck/
   * failed", not the archive. Pass states: ["finished"] (or include it
   * alongside others) to see completed downloads too.
   */
  states?: string[];
  /** Cap the number of results, most-recently-started first. Default unlimited. */
  limit?: number;
}

export function listDownloads(
  api: IExtensionApi,
  gameId?: string,
  options: ListDownloadsOptions = {},
): DownloadSummary[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const files =
    (queryStatePath(api, ["persistent", "downloads", "files"]) as
      | Record<string, types.IDownload>
      | undefined) ?? {};
  const stateFilter = new Set(options.states ?? []);
  const summaries = Object.entries(files)
    .filter(([, download]) => download.game.includes(targetGameId))
    .filter(([, download]) =>
      options.states === undefined
        ? download.state !== "finished"
        : stateFilter.has(download.state),
    )
    .toSorted(([, a], [, b]) => b.startTime - a.startTime)
    .map(([downloadId, download]) => ({
      // download.id itself is only reliably populated for "finished" downloads — found
      // live that a "failed" download's own id field can be undefined even though the
      // Redux map key (downloadId here) is always the real, addressable id.
      id: downloadId,
      name: download.modInfo?.name ?? download.localPath ?? downloadId,
      state: download.state,
      progress:
        download.size > 0 ? Math.round(((download.received ?? 0) / download.size) * 100) : 0,
      size: download.size,
      startTime: download.startTime,
      installedModId: (download as unknown as { installed?: { modId?: string } }).installed?.modId,
    }));
  return options.limit !== undefined ? summaries.slice(0, options.limit) : summaries;
}

export interface StaleDownloadEntry {
  downloadId: string;
  fileName: string;
  fileVersion?: string;
  state: string;
  /** Found live: not populated on some older/"finished" download records. */
  startTime?: number;
  /**
   * True when THIS download is the one currently installed (installed.modId set) —
   * never treat this one as redundant regardless of how it compares to the others in
   * its group. Found live: MORE THAN ONE entry in a group can show true simultaneously
   * (Vortex updates a mod in place under the same modId, so an older download can still
   * carry a stale-but-live-looking installed pointer even though a newer download is
   * what's actually deployed — same caveat list_downloads' installedModId documents).
   * Don't assume exactly one true value per group.
   */
  installed: boolean;
}

export interface StaleDownloadGroup {
  /** The shared Nexus mod page id every entry in this group was downloaded from. */
  nexusModId: number;
  downloads: StaleDownloadEntry[];
}

/**
 * Groups downloads that came from the SAME Nexus mod page (download.modInfo.nexus.
 * ids.modId — found live, not the same field list_downloads' installedModId reads,
 * which is a Vortex-internal id) and reports every group with more than one entry —
 * multiple archives ever downloaded for one mod, typically across versions. A genuine
 * join reflection can't do in one call: requires reading every download's nested
 * modInfo, grouping by the Nexus id inside it, and filtering to actual duplicates.
 * Marks which entry (if any) is the one currently installed; every other entry in a
 * multi-entry group is a real candidate for manual deletion (an old/superseded archive
 * still taking up disk space) — reports raw facts only, no verdict, matching list_
 * duplicate_mods' stance, since a caller may have a real reason to keep an old version.
 */
export function findStaleDownloads(api: IExtensionApi, gameId?: string): StaleDownloadGroup[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const files =
    (queryStatePath(api, ["persistent", "downloads", "files"]) as
      | Record<
          string,
          {
            game?: string[];
            localPath?: string;
            state: string;
            // Found live: not populated on some older/"finished" download records.
            startTime?: number;
            installed?: { modId?: string };
            modInfo?: {
              nexus?: { ids?: { modId?: number } };
              meta?: { fileName?: string; fileVersion?: string };
            };
          }
        >
      | undefined) ?? {};

  const byNexusModId = new Map<number, Array<{ id: string; download: (typeof files)[string] }>>();
  for (const [id, download] of Object.entries(files)) {
    if (!(download.game ?? []).includes(targetGameId)) {
      continue;
    }
    const nexusModId = download.modInfo?.nexus?.ids?.modId;
    if (nexusModId === undefined) {
      continue;
    }
    const list = byNexusModId.get(nexusModId) ?? [];
    list.push({ id, download });
    byNexusModId.set(nexusModId, list);
  }

  const groups: StaleDownloadGroup[] = [];
  for (const [nexusModId, entries] of byNexusModId) {
    if (entries.length < 2) {
      continue;
    }
    groups.push({
      nexusModId,
      // Found live: startTime is missing on some older/"finished" download records, not
      // just theoretically possible — fall back to 0 so the sort stays well-defined
      // instead of comparing against NaN.
      downloads: entries
        .toSorted((a, b) => (b.download.startTime ?? 0) - (a.download.startTime ?? 0))
        .map(({ id, download }) => ({
          downloadId: id,
          fileName: download.localPath ?? download.modInfo?.meta?.fileName ?? id,
          fileVersion: download.modInfo?.meta?.fileVersion,
          state: download.state,
          startTime: download.startTime,
          installed: download.installed?.modId !== undefined,
        })),
    });
  }
  return groups.toSorted((a, b) => a.nexusModId - b.nexusModId);
}

export interface NotificationSummary {
  id?: string;
  type: string;
  title?: string;
  message: string;
}

export function listNotifications(api: IExtensionApi): NotificationSummary[] {
  const st = state(api);
  const notifications = selectors.notifications(st) as types.INotification[];
  return notifications.map((n) => ({ id: n.id, type: n.type, title: n.title, message: n.message }));
}

export interface DialogSummary {
  id: string;
  type: string;
  title: string;
  /** Flattened from content.message/text/bbcode/md/htmlText, whichever is set. */
  message?: string;
  /** The exact labels closeDialog's `actionKey` must match — read this, don't guess. */
  actions: string[];
  defaultAction?: string;
  checkboxes?: { id: string; text?: string; value: boolean }[];
  input?: { id: string; label?: string; value?: string }[];
}

/**
 * Lists Vortex's currently-open modal dialogs (context.api.showDialog), e.g. the
 * "files changed outside Vortex" prompt that can block a deploy. Distinct from
 * list_notifications' toast notifications — same INotificationState slice
 * (state.session.notifications), different field (`dialogs`, confirmed live: not
 * documented anywhere as a state path, only found by tracing IDialog's declared
 * home through @nexusmods/vortex-api's types). Use closeDialog via vortex_dispatch
 * to respond, picking one of this dialog's own `actions` labels.
 */
export function listDialogs(api: IExtensionApi): DialogSummary[] {
  const dialogs =
    (queryStatePath(api, ["session", "notifications", "dialogs"]) as types.IDialog[] | undefined) ??
    [];
  return dialogs.map((d) => {
    const content = d.content as {
      message?: string;
      text?: string;
      bbcode?: string;
      md?: string;
      htmlText?: string;
      checkboxes?: { id: string; text?: string; value: boolean }[];
      input?: { id: string; label?: string; value?: string }[];
    };
    return {
      id: d.id,
      type: d.type,
      title: d.title,
      message: content.message ?? content.text ?? content.bbcode ?? content.md ?? content.htmlText,
      actions: d.actions,
      defaultAction: d.defaultAction,
      checkboxes: content.checkboxes,
      input: content.input,
    };
  });
}

export interface ExternalFileChange {
  filePath: string;
  /** Mod id the deployed file came from. */
  source: string;
  modTypeId: string;
  type: string;
  /** The action that will be applied when confirmed, e.g. "newest" — Vortex's own default pick per entry, not something this project computes. */
  action: string;
  sourceModified: string;
  destModified: string;
}

/**
 * Lists pending "external changes" Vortex detected (a deployed file differs from what
 * Vortex itself put there — edited outside Vortex, or a mod rewriting its own file at
 * runtime, e.g. an SKSE plugin that self-updates) that are BLOCKING an in-progress
 * deploy/purge/profile-switch. Found live to be a genuinely separate mechanism from
 * list_dialogs: the real in-app "External Changes" dialog (ExternalChangeDialog.tsx)
 * blocks on a private module-scoped Promise inside mod_management's own code, not
 * Vortex's generic showDialog/session.notifications.dialogs state list_dialogs reads —
 * confirmed live that list_dialogs returns [] while this was genuinely open and had
 * stalled a real deploy for over 10 minutes with no visible signal anywhere else this
 * project already surfaces (list_notifications only showed a generic "Deploying"
 * activity, no hint it was actually stuck waiting on a decision). A non-empty result
 * here, combined with a stalled "Deploying" notification, means a deploy is blocked on
 * this — even though every other read tool looks like nothing is wrong.
 *
 * RESOLUTION: this project's Vortex source tree has (as of this writing) unbuilt,
 * uncommitted registerAPI calls for exactly this — setExternalChangeAction(filePaths,
 * action) and confirmExternalChanges(cancel?) in mod_management/index.ts — but they were
 * confirmed NOT present in vortex_describe's live apiMethods/extensionApis on the
 * currently-running build (dispatching confirmExternalChanges failed with "Unknown
 * action..."). Once a Vortex build that includes them is running, dispatch
 * confirmExternalChanges via vortex_dispatch to accept each entry's already-chosen
 * `action` and unblock the deploy; until then, this tool can DETECT the block but not
 * resolve it — the dialog must be answered in Vortex's own UI.
 */
export function listExternalChanges(api: IExtensionApi): ExternalFileChange[] {
  return (
    (queryStatePath(api, ["session", "mods", "changes"]) as ExternalFileChange[] | undefined) ?? []
  );
}

export interface ModRuleSummary {
  type: string;
  /**
   * Undefined when the rule doesn't reference a specific mod by id at all — found live:
   * a "conflicts" rule commonly guards against a different *version* of the same logical
   * file rather than naming another mod (see logicalFileName), so there's genuinely
   * nothing to resolve here, not a lookup failure.
   */
  targetId?: string;
  /** Friendly name of the referenced mod, when it's installed and resolvable. */
  targetName?: string;
  /** Set when the rule matches by file identity rather than (or in addition to) modId — the real target when targetId is undefined. */
  logicalFileName?: string;
  versionMatch?: string;
  /** Free-text explanation Vortex/the mod author attached to the rule, when present (e.g. "Incompatible Script Extender"). */
  comment?: string;
}

/**
 * Lists a mod's dependency/conflict rules (before/after/requires/conflicts/...),
 * resolving each reference to the target mod's friendly name when it's installed
 * — a join raw reflection can't do, same reasoning as list_mods/list_categories.
 * Real data, not speculative: 184 of 692 mods in the live test profile have rules.
 */
export function listModRules(api: IExtensionApi, modId: string, gameId?: string): ModRuleSummary[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const mod = mods[modId];
  if (mod === undefined) {
    throw new Error(`Unknown mod: ${modId}`);
  }
  // IModRule extends an IRule base that isn't fully resolved in the published .d.ts
  // (`type`/`comment` on the rule, `versionMatch`/`logicalFileName` on the reference are
  // all real at runtime — confirmed against live state — but absent from the exported
  // type). A "conflicts" rule commonly has neither `id` nor `idHint` at all: found live
  // on Skyrim Script Extender VR, it guards against a *different version of the same
  // logical file* (reference: {logicalFileName, versionMatch}), not another mod — there
  // is genuinely no modId to resolve there, `comment` ("Incompatible Script Extender")
  // is the real explanation.
  type RealModRule = {
    type: string;
    comment?: string;
    reference: { id?: string; idHint?: string; versionMatch?: string; logicalFileName?: string };
  };
  return (mod.rules ?? []).map((ruleTyped) => {
    const rule = ruleTyped as unknown as RealModRule;
    const targetId = rule.reference.id ?? rule.reference.idHint;
    const targetMod = targetId !== undefined ? mods[targetId] : undefined;
    return {
      type: rule.type,
      targetId,
      targetName: targetMod !== undefined ? util.renderModName(targetMod) : undefined,
      logicalFileName: rule.reference.logicalFileName,
      versionMatch: rule.reference.versionMatch,
      comment: rule.comment,
    };
  });
}

export interface ModDependentSummary {
  modId: string;
  modName: string;
  /** The rule type the dependent mod recorded against this one (before/after/requires/conflicts/recommends/...). */
  ruleType: string;
  enabled: boolean;
  versionMatch?: string;
}

/**
 * The reverse of listModRules: finds every OTHER installed mod whose own rules
 * reference this modId — "what depends on/conflicts with/orders around this mod". A
 * genuine join reflection can't do in one call: listModRules only returns rules
 * recorded ON the mod you ask about, so answering "is it safe to update or remove this
 * mod" otherwise means calling listModRules once per OTHER installed mod (hundreds of
 * calls on a large modlist — found live, one profile alone had 617 installed mods) and
 * filtering the results client-side.
 */
export function findModDependents(
  api: IExtensionApi,
  modId: string,
  gameId?: string,
): ModDependentSummary[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  if (mods[modId] === undefined) {
    throw new Error(`Unknown mod: ${modId}`);
  }
  const profile = selectors.activeProfile(st);
  const isEnabled = (id: string): boolean =>
    profile?.gameId === targetGameId ? (profile?.modState?.[id]?.enabled ?? false) : false;

  type RealModRule = {
    type: string;
    reference: { id?: string; idHint?: string; versionMatch?: string };
  };
  const dependents: ModDependentSummary[] = [];
  for (const mod of Object.values(mods)) {
    if (mod.id === modId) {
      continue;
    }
    const rules = (mod.rules ?? []) as unknown as RealModRule[];
    for (const rule of rules) {
      const targetId = rule.reference.id ?? rule.reference.idHint;
      if (targetId === modId) {
        dependents.push({
          modId: mod.id,
          modName: util.renderModName(mod),
          ruleType: rule.type,
          enabled: isEnabled(mod.id),
          versionMatch: rule.reference.versionMatch,
        });
      }
    }
  }
  return dependents;
}

// Vortex doesn't expose a selector or reflectable API for "which mod owns this file" or
// "which mods conflict on which files" — the closest event names found via vortex_describe
// (get-mod-files, update-conflicts-and-rules) are undocumented internal conventions with
// unknown argument shapes, not safe to guess blindly on a live install. Both questions are
// answerable directly from data we already have though: each mod's on-disk staging folder
// (settings.mods.installPath[gameId] + mod.installationPath) is real, present state — so
// these two functions answer both by scanning the filesystem themselves, the same kind of
// join list_mods/list_categories/list_mod_rules already do that reflection alone can't.

async function listModFiles(stagingRoot: string, installationPath: string): Promise<string[]> {
  const modDir = path.join(stagingRoot, installationPath);
  let entries: string[];
  try {
    entries = (await readdir(modDir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const files: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const entryStat = await stat(path.join(modDir, entry));
        if (entryStat.isFile()) {
          files.push(entry);
        }
      } catch {
        // File removed mid-scan or a broken symlink — skip it.
      }
    }),
  );
  return files;
}

// settings.mods.installPath[gameId] is a raw, unresolved template (e.g. "E:\Vortex
// Mods\{game}" — found live, "{game}"/"{userdata}"/"{username}" placeholders via the
// string-template package) — reading it directly, as this used to, silently produced a
// staging root that doesn't exist on disk, so every scan under it (findModByFile among
// others) failed closed with an empty result instead of an error. installPathForGame
// resolves the placeholders the same way Vortex's own mod-install code does.
function stagingRootFor(api: IExtensionApi, gameId: string): string {
  const stagingRoot = selectors.installPathForGame(state(api), gameId) as string | undefined;
  if (stagingRoot === undefined) {
    throw new Error(`No mod staging path configured for ${gameId}`);
  }
  return stagingRoot;
}

export interface ModFileMatch {
  modId: string;
  modName: string;
  relativePath: string;
  enabled: boolean;
}

/**
 * Finds which installed mod(s) contain a file with this name, by scanning mod staging
 * folders on disk (see the note above listModFiles). Scans only enabled mods by default —
 * fast (tens of mods); pass includeDisabled to search every installed mod instead, which
 * is much slower (a real profile can have hundreds) but useful for hunting down an
 * orphaned or leftover file whose owning mod isn't currently enabled.
 */
export async function findModByFile(
  api: IExtensionApi,
  filename: string,
  options: { gameId?: string; includeDisabled?: boolean } = {},
): Promise<ModFileMatch[]> {
  const st = state(api);
  const targetGameId = resolveGameId(options.gameId, st);
  const stagingRoot = stagingRootFor(api, targetGameId);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const isEnabled = (modId: string): boolean =>
    profile?.gameId === targetGameId ? (profile?.modState?.[modId]?.enabled ?? false) : false;

  const candidates = Object.values(mods).filter(
    (mod) => options.includeDisabled === true || isEnabled(mod.id),
  );
  const needle = filename.toLowerCase();
  const matches: ModFileMatch[] = [];
  await Promise.all(
    candidates.map(async (mod) => {
      const files = await listModFiles(stagingRoot, mod.installationPath);
      for (const relPath of files) {
        if (path.basename(relPath).toLowerCase() === needle) {
          matches.push({
            modId: mod.id,
            modName: util.renderModName(mod),
            relativePath: relPath,
            enabled: isEnabled(mod.id),
          });
        }
      }
    }),
  );
  return matches;
}

export type FileConflictRisk = "high" | "medium" | "low";

export interface FileConflictEntry {
  /** Relative path (lowercased) within the deployed mod folder that more than one enabled mod provides. */
  file: string;
  mods: { id: string; name: string }[];
  /**
   * A coarse hint for how much a conflict on this file type usually matters — scripts/
   * plugins/archives (high) can affect runtime behavior and quest logic; interface/config
   * (medium) can break menus and generated patch outputs; everything else (low, e.g.
   * meshes/textures) is usually cosmetic. Purely a file-extension classification, not a
   * judgment about THIS specific conflict — still doesn't say who wins or what to do.
   */
  risk: FileConflictRisk;
}

const HIGH_RISK_EXTENSIONS = new Set([".esp", ".esm", ".esl", ".dll", ".pex", ".bsa", ".ba2"]);
const MEDIUM_RISK_EXTENSIONS = new Set([".ini", ".json", ".xml", ".txt", ".swf", ".gfx"]);

function fileConflictRisk(relPath: string): FileConflictRisk {
  const ext = path.extname(relPath).toLowerCase();
  if (HIGH_RISK_EXTENSIONS.has(ext)) {
    return "high";
  }
  if (MEDIUM_RISK_EXTENSIONS.has(ext)) {
    return "medium";
  }
  return "low";
}

/**
 * Finds files provided by more than one currently-enabled mod (for the active/given
 * profile) — the read side of conflict resolution; the write side already exists via
 * vortex_dispatch (setFileOverride to pick a winner, addModRule with type "before"/"after"
 * to control load/deploy order). Deliberately doesn't report a "winner": Vortex's actual
 * resolution depends on deploy/rule order in ways not safe to reimplement here — this
 * just tells you what needs resolving. `risk` is a coarse file-type hint (scripts/plugins
 * matter more than textures), not a resolution.
 */
export async function listFileConflicts(
  api: IExtensionApi,
  options: { gameId?: string; nameFilter?: string; limit?: number } = {},
): Promise<FileConflictEntry[]> {
  const st = state(api);
  const targetGameId = resolveGameId(options.gameId, st);
  const stagingRoot = stagingRootFor(api, targetGameId);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const enabledMods =
    profile?.gameId === targetGameId
      ? Object.values(mods).filter((mod) => profile?.modState?.[mod.id]?.enabled === true)
      : [];

  const owners = new Map<string, { id: string; name: string }[]>();
  await Promise.all(
    enabledMods.map(async (mod) => {
      const files = await listModFiles(stagingRoot, mod.installationPath);
      for (const relPath of files) {
        const key = relPath.toLowerCase();
        const list = owners.get(key) ?? [];
        list.push({ id: mod.id, name: util.renderModName(mod) });
        owners.set(key, list);
      }
    }),
  );

  const nameFilterLower = options.nameFilter?.toLowerCase();
  const entries: FileConflictEntry[] = [];
  for (const [file, ownerList] of owners) {
    if (ownerList.length < 2) {
      continue;
    }
    if (nameFilterLower !== undefined && !file.includes(nameFilterLower)) {
      continue;
    }
    entries.push({ file, mods: ownerList, risk: fileConflictRisk(file) });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return options.limit !== undefined ? entries.slice(0, options.limit) : entries;
}

// Reads a plugin's (.esp/.esm/.esl) master list straight from its TES4 header — the
// Bethesda plugin format is a fixed, unchanging binary spec (not Vortex-specific), so
// this is safe to implement directly rather than guessing at Vortex behavior. Record
// header: 4-byte type, 4-byte data size (uint32 LE), 16 more header bytes, then that
// many bytes of subrecords (4-byte type, 2-byte size (uint16 LE), data). MAST
// subrecords hold a null-terminated master filename.
async function readPluginMasters(filePath: string): Promise<string[]> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(24);
    const { bytesRead } = await handle.read(head, 0, 24, 0);
    if (bytesRead < 24 || head.toString("ascii", 0, 4) !== "TES4") {
      return [];
    }
    const dataSize = head.readUInt32LE(4);
    const data = Buffer.alloc(dataSize);
    await handle.read(data, 0, dataSize, 24);
    const masters: string[] = [];
    let offset = 0;
    while (offset + 6 <= data.length) {
      const type = data.toString("ascii", offset, offset + 4);
      const size = data.readUInt16LE(offset + 4);
      const fieldStart = offset + 6;
      if (fieldStart + size > data.length) {
        break;
      }
      if (type === "MAST") {
        let end = fieldStart;
        while (end < fieldStart + size && data[end] !== 0) {
          end++;
        }
        masters.push(data.toString("ascii", fieldStart, end));
      }
      offset = fieldStart + size;
    }
    return masters;
  } finally {
    await handle.close();
  }
}

export interface MissingMastersEntry {
  plugin: string;
  missingMasters: string[];
}

/**
 * Finds enabled plugins whose master files aren't themselves enabled — reads each
 * plugin's real TES4 header from the game's Data folder rather than trusting any
 * Vortex-side bookkeeping, since Vortex doesn't expose a "resolved masters" selector.
 * A very common real troubleshooting need (a patch enabled without its base mod).
 */
export async function findMissingMasters(
  api: IExtensionApi,
  gameId?: string,
): Promise<MissingMastersEntry[]> {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const gamePath = queryStatePath(api, [
    "settings",
    "gameMode",
    "discovered",
    targetGameId,
    "path",
  ]) as string | undefined;
  if (gamePath === undefined) {
    throw new Error(`Game ${targetGameId} is not discovered (no installation path known).`);
  }
  const dataDir = path.join(gamePath, "Data");
  const loadOrder = listLoadOrder(api);
  const enabledPlugins = loadOrder.filter((entry) => entry.enabled).map((entry) => entry.plugin);
  const enabledSet = new Set(enabledPlugins.map((plugin) => plugin.toLowerCase()));

  const results: MissingMastersEntry[] = [];
  await Promise.all(
    enabledPlugins.map(async (plugin) => {
      const masters = await readPluginMasters(path.join(dataDir, plugin)).catch(() => []);
      const missing = masters.filter((master) => !enabledSet.has(master.toLowerCase()));
      if (missing.length > 0) {
        results.push({ plugin, missingMasters: missing });
      }
    }),
  );
  results.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return results;
}

// Vortex doesn't track game logs at all (Papyrus/SKSE/crash logs are the game engine's
// own output, not Vortex state) — these live at a fixed, well-known Bethesda-games
// location: Documents/My Games/<game>. Only games this project has actually verified the
// folder name for are listed — deliberately not guessed for anything else (see the
// clear error below for an unsupported gameId).
const MY_GAMES_FOLDER: Record<string, string> = {
  skyrimse: "Skyrim Special Edition",
  skyrimvr: "Skyrim VR",
};

const MENTIONED_FILE_PATTERN = /\S+\.(?:esp|esm|esl|dll|pex)\b/gi;

function extractMentionedFiles(text: string): string[] {
  const matches = text.match(MENTIONED_FILE_PATTERN) ?? [];
  return [...new Set(matches.map((match) => match.trim()))];
}

export interface RuntimeErrorEntry {
  source: "papyrus" | "crash";
  file: string;
  mtime: string;
  excerpt: string;
  /** .esp/.esm/.esl/.dll/.pex filenames spotted in the text — pass one to find_mod_by_file to resolve. */
  mentionedFiles: string[];
}

/**
 * Reads recent Papyrus error lines and crash log excerpts from the game's real save-data
 * folder (Documents/My Games/<game>) — pure filesystem reading, since Vortex has no
 * concept of game runtime logs. Doesn't try to parse or explain crash log internals
 * (format varies by crash-logging mod) — just surfaces the raw excerpt for the caller
 * to reason about, and lists any mod-ish filenames mentioned so find_mod_by_file can
 * resolve them.
 */
export async function listRuntimeErrors(
  api: IExtensionApi,
  options: { gameId?: string; maxCrashLogs?: number } = {},
): Promise<RuntimeErrorEntry[]> {
  const st = state(api);
  const targetGameId = resolveGameId(options.gameId, st);
  const myGamesFolder = MY_GAMES_FOLDER[targetGameId];
  if (myGamesFolder === undefined) {
    throw new Error(
      `Don't know the save-data folder name for ${targetGameId}. Supported: ` +
        Object.keys(MY_GAMES_FOLDER).join(", "),
    );
  }
  const documentsPath = util.getVortexPath("documents");
  const gameDocsRoot = path.join(documentsPath, "My Games", myGamesFolder);

  const entries: RuntimeErrorEntry[] = [];

  const papyrusPath = path.join(gameDocsRoot, "Logs", "Script", "Papyrus.0.log");
  try {
    const content = await readFile(papyrusPath, "utf8");
    const papyrusStat = await stat(papyrusPath);
    const errorLines = content.split(/\r?\n/).filter((line) => /error/i.test(line));
    for (const line of errorLines.slice(-50)) {
      entries.push({
        source: "papyrus",
        file: papyrusPath,
        mtime: papyrusStat.mtime.toISOString(),
        excerpt: line.trim(),
        mentionedFiles: extractMentionedFiles(line),
      });
    }
  } catch {
    // No Papyrus log yet — nothing to report from this source.
  }

  const skseDir = path.join(gameDocsRoot, "SKSE");
  try {
    const files = await readdir(skseDir);
    const crashFiles = files.filter((file) => /^crash-.*\.log$/i.test(file));
    const withStats = await Promise.all(
      crashFiles.map(async (file) => ({ file, fileStat: await stat(path.join(skseDir, file)) })),
    );
    withStats.sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs);
    const maxCrashLogs = options.maxCrashLogs ?? 3;
    for (const { file, fileStat } of withStats.slice(0, maxCrashLogs)) {
      const fullPath = path.join(skseDir, file);
      const content = await readFile(fullPath, "utf8");
      const excerpt = content.split(/\r?\n/).slice(0, 15).join("\n");
      entries.push({
        source: "crash",
        file: fullPath,
        mtime: fileStat.mtime.toISOString(),
        excerpt,
        mentionedFiles: extractMentionedFiles(excerpt),
      });
    }
  } catch {
    // No SKSE folder / no crash logs — nothing to report from this source.
  }

  return entries;
}

export type DuplicateModReason = "same-nexus-id" | "file-subset";

export interface DuplicateModGroup {
  reason: DuplicateModReason;
  mods: { id: string; name: string }[];
  detail: string;
}

/**
 * Finds installed mods that look like duplicates or redundant leftovers — never
 * auto-resolved, purely informational (same "report candidates, don't decide" stance as
 * list_file_conflicts). Two independent checks:
 *  - same-nexus-id: more than one installed mod sharing the same Nexus mod.attributes.modId
 *    (metadata-only, cheap, runs across the full candidate set).
 *  - file-subset: mod B's entire file set is contained in mod A's — usually an old/
 *    redundant version left installed. O(n^2) file-set comparisons, so scanning every
 *    installed mod (includeDisabled) can be slow for a large modlist; enabled-only (the
 *    default) is fast.
 */
export async function listDuplicateMods(
  api: IExtensionApi,
  options: { gameId?: string; includeDisabled?: boolean } = {},
): Promise<DuplicateModGroup[]> {
  const st = state(api);
  const targetGameId = resolveGameId(options.gameId, st);
  const stagingRoot = stagingRootFor(api, targetGameId);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const isEnabled = (modId: string): boolean =>
    profile?.gameId === targetGameId ? (profile?.modState?.[modId]?.enabled ?? false) : false;
  const candidates = Object.values(mods).filter(
    (mod) => options.includeDisabled === true || isEnabled(mod.id),
  );

  const groups: DuplicateModGroup[] = [];

  const byNexusId = new Map<string, IMod[]>();
  for (const mod of candidates) {
    const attrs = mod.attributes as { source?: string; modId?: string | number } | undefined;
    if (attrs?.source !== "nexus" || attrs.modId === undefined) {
      continue;
    }
    const key = String(attrs.modId);
    const list = byNexusId.get(key) ?? [];
    list.push(mod);
    byNexusId.set(key, list);
  }
  for (const [nexusId, modsForId] of byNexusId) {
    if (modsForId.length > 1) {
      groups.push({
        reason: "same-nexus-id",
        mods: modsForId.map((mod) => ({ id: mod.id, name: util.renderModName(mod) })),
        detail: `Nexus mod id ${nexusId} installed ${modsForId.length} times`,
      });
    }
  }

  const fileSets = new Map<string, Set<string>>();
  await Promise.all(
    candidates.map(async (mod) => {
      const files = await listModFiles(stagingRoot, mod.installationPath);
      fileSets.set(mod.id, new Set(files.map((file) => file.toLowerCase())));
    }),
  );
  for (const outer of candidates) {
    for (const inner of candidates) {
      if (outer.id === inner.id) {
        continue;
      }
      const outerFiles = fileSets.get(outer.id);
      const innerFiles = fileSets.get(inner.id);
      if (
        outerFiles === undefined ||
        innerFiles === undefined ||
        innerFiles.size === 0 ||
        innerFiles.size >= outerFiles.size
      ) {
        continue;
      }
      const isSubset = [...innerFiles].every((file) => outerFiles.has(file));
      if (isSubset) {
        groups.push({
          reason: "file-subset",
          mods: [
            { id: outer.id, name: util.renderModName(outer) },
            { id: inner.id, name: util.renderModName(inner) },
          ],
          detail: `${util.renderModName(inner)}'s files are all present in ${util.renderModName(outer)}`,
        });
      }
    }
  }

  return groups;
}

export interface StaleModCandidate {
  modId: string;
  modName: string;
  /**
   * Epoch ms this mod's enabled state was last toggled — found live: profile.modState
   * carries this even for currently-disabled mods, tracking the last flip either
   * direction, not just "last enabled." How long ago this was is the actual "how stale"
   * signal; a mod disabled the same day it was installed and a mod disabled two years
   * ago look identical in every other respect.
   */
  disabledSince: number;
  /** ISO timestamp this mod was originally installed, when known. */
  installTime?: string;
}

/**
 * Lists DISABLED mods for a profile (defaults to the active one), sorted oldest-
 * disabled first — candidates for actually removing rather than leaving disabled
 * forever. A genuine join reflection can't do in one call: the enabled flag lives on
 * profile.modState, the "how long has it been disabled" timestamp lives on that same
 * modState entry (enabledTime, despite the name — found live), and the mod's own
 * name/install date live on the separate persistent.mods record. Reports raw facts
 * only, no verdict — a disabled-since timestamp doesn't tell you WHY it's disabled
 * (some mods are deliberately kept disabled as alternates, e.g. two versions of a
 * texture pack for different playthroughs).
 */
export function findStaleMods(
  api: IExtensionApi,
  options: { gameId?: string; profileId?: string; limit?: number } = {},
): StaleModCandidate[] {
  const st = state(api);
  const targetGameId = resolveGameId(options.gameId, st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile =
    options.profileId !== undefined
      ? (selectors.profiles(st)[options.profileId] as IProfile | undefined)
      : (selectors.activeProfile(st) as IProfile | undefined);
  if (profile === undefined) {
    throw new Error(
      options.profileId !== undefined
        ? `Unknown profile: ${options.profileId}`
        : "No active profile and no profileId provided",
    );
  }

  const candidates: StaleModCandidate[] = [];
  for (const [modId, s] of Object.entries(
    profile.modState as unknown as Record<string, { enabled?: boolean; enabledTime?: number }>,
  )) {
    const mod = mods[modId];
    if (s.enabled === true || mod === undefined) {
      continue;
    }
    candidates.push({
      modId,
      modName: util.renderModName(mod),
      disabledSince: s.enabledTime ?? 0,
      installTime: (mod.attributes as { installTime?: string } | undefined)?.installTime,
    });
  }
  candidates.sort((a, b) => a.disabledSince - b.disabledSince);
  return options.limit !== undefined ? candidates.slice(0, options.limit) : candidates;
}

export interface KnownModConflictMatch {
  modId: string;
  modName: string;
  /**
   * Undefined when the rule doesn't name another mod at all — found live: a "conflicts"
   * rule commonly guards against a different *version* of the same logical file (see
   * logicalFileName), not a separate mod, and there's genuinely no id to resolve then.
   */
  targetId?: string;
  /** Name of the conflicting mod, only set when that mod is also currently installed. */
  targetName?: string;
  /** Set when the rule matches by file identity rather than (or in addition to) modId — the real target when targetId is undefined. */
  logicalFileName?: string;
  /**
   * Version range this rule guards against, when present — found live: a mod can carry
   * several "conflicts" rules against its OWN logicalFileName, one per incompatible
   * version range (e.g. "<2.0.12||>2.0.12" and "<2.0.11||>2.0.11"). Without this field
   * those rules are indistinguishable in the output even though they're different rules.
   */
  versionMatch?: string;
  /** True when the conflicting mod is both installed AND currently enabled — an active conflict. Always false when targetId is undefined (nothing to check). */
  targetEnabled: boolean;
  /** Free-text explanation Vortex/the mod author attached to the rule, when present (e.g. "Incompatible Script Extender"). */
  comment?: string;
}

/**
 * Surfaces real "conflicts"-type rules Vortex already has recorded on installed mods
 * (mod.rules — the same field list_mod_rules reads, often populated from Nexus mod page
 * metadata or added by the user) for the currently-enabled mod set. This is genuine
 * Vortex data, not invented domain knowledge — deliberately does NOT hardcode any
 * mod-compatibility facts of its own.
 */
export function listKnownModConflicts(
  api: IExtensionApi,
  gameId?: string,
): KnownModConflictMatch[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const isEnabled = (modId: string): boolean =>
    profile?.gameId === targetGameId ? (profile?.modState?.[modId]?.enabled ?? false) : false;
  const enabledMods = Object.values(mods).filter((mod) => isEnabled(mod.id));

  type RealModRule = {
    type: string;
    comment?: string;
    reference: { id?: string; idHint?: string; logicalFileName?: string; versionMatch?: string };
  };
  const matches: KnownModConflictMatch[] = [];
  for (const mod of enabledMods) {
    const rules = (mod.rules ?? []) as unknown as RealModRule[];
    for (const rule of rules) {
      if (rule.type !== "conflicts") {
        continue;
      }
      const targetId = rule.reference.id ?? rule.reference.idHint;
      const targetMod = targetId !== undefined ? mods[targetId] : undefined;
      matches.push({
        modId: mod.id,
        modName: util.renderModName(mod),
        targetId,
        targetName: targetMod !== undefined ? util.renderModName(targetMod) : undefined,
        logicalFileName: rule.reference.logicalFileName,
        versionMatch: rule.reference.versionMatch,
        targetEnabled: targetId !== undefined && isEnabled(targetId),
        comment: rule.comment,
      });
    }
  }
  return matches;
}

export interface UnsolvedConflict {
  modId: string;
  modName: string;
  otherModId: string;
  otherModName: string;
  /** Absolute paths of the specific files both mods provide. */
  files: string[];
  /**
   * Vortex's OWN computed recommendation for resolving this specific conflict, when it
   * has one confident answer (found live: this is real data from the built-in
   * mod-dependency-manager extension's determineConflicts, the same "Suggested" option
   * offered in Vortex's own conflict-resolution dialog — not something this project
   * invented). `null` means Vortex has no confident suggestion for this pair (e.g.
   * mixed/contradictory signals) and a human has to choose. To apply a non-null
   * suggestion: vortex_dispatch action="addModRule" args=[gameId, modId, {type:
   * suggestion, reference: {id: otherModId}}] — "modId" here is THIS entry's modId, not
   * otherModId; get the direction backwards and you'll load the wrong mod first.
   */
  suggestion: "before" | "after" | null;
}

/**
 * Surfaces file conflicts between currently-enabled mods that have NO rule resolving
 * them yet (before/after/conflicts-type, checked on both mods, either direction) — the
 * read side of Vortex's own conflict-resolution ("Set Rule") workflow, which
 * list_file_conflicts explicitly declines to editorialize on. A genuine join reflection
 * can't do in one call: state.session.dependencies.conflicts (populated by the built-in
 * mod-dependency-manager extension, kept live in sync with mod/profile changes — found
 * live via reading that extension's own source, not published in @nexusmods/vortex-api's
 * types) records each conflicting pair TWICE, once under each mod's id, so this dedupes
 * by unordered pair and cross-references mod.rules on both sides to drop anything already
 * resolved, exactly mirroring that extension's own isConflictResolved logic. Always
 * scoped to the ACTIVE game — this data has no gameId axis to query by (mirrors
 * list_load_order in that respect).
 */
export function listUnsolvedConflicts(api: IExtensionApi): UnsolvedConflict[] {
  const st = state(api);
  const targetGameId = selectors.activeGameId(st) as string | undefined;
  if (targetGameId === undefined || targetGameId.length === 0) {
    throw new Error("No active game — file conflicts are only tracked for the active game.");
  }
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const conflicts =
    (queryStatePath(api, ["session", "dependencies", "conflicts"]) as
      | Record<
          string,
          Array<{
            otherMod: { id: string; name?: string };
            files: string[];
            suggestion: "before" | "after" | null;
          }>
        >
      | undefined) ?? {};

  type RealModRule = { type: string; reference: { id?: string; idHint?: string } };
  const CONFLICT_RULE_TYPES = new Set(["before", "after", "conflicts"]);
  const hasResolvingRule = (fromId: string, towardId: string): boolean =>
    ((mods[fromId]?.rules ?? []) as unknown as RealModRule[]).some(
      (rule) =>
        CONFLICT_RULE_TYPES.has(rule.type) &&
        (rule.reference.id === towardId || rule.reference.idHint === towardId),
    );
  const isResolved = (modId: string, otherModId: string): boolean =>
    hasResolvingRule(modId, otherModId) || hasResolvingRule(otherModId, modId);

  const result: UnsolvedConflict[] = [];
  const seenPairs = new Set<string>();
  for (const [modId, entries] of Object.entries(conflicts)) {
    for (const entry of entries) {
      const otherModId = entry.otherMod.id;
      const pairKey = [modId, otherModId].toSorted().join(":");
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);
      if (isResolved(modId, otherModId)) {
        continue;
      }
      result.push({
        modId,
        modName: mods[modId] !== undefined ? util.renderModName(mods[modId]) : modId,
        otherModId,
        otherModName: entry.otherMod.name ?? otherModId,
        files: entry.files,
        suggestion: entry.suggestion,
      });
    }
  }
  return result;
}

export interface DeploymentDiscrepancy {
  plugin: string;
  /**
   * Whether Vortex's active-profile load order has this PLUGIN (esp/esm/esl) enabled —
   * not the same as a mod's overall enabled state (ModSummary.enabled). A mod shipping
   * several plugin variants can be mod-enabled while most of its individual plugins are
   * load-order-disabled; that's normal, not itself a discrepancy.
   */
  vortexEnabled: boolean;
  /** Whether the plugin file actually exists in the game's Data folder. */
  existsInDataFolder: boolean;
  /**
   * Whether the game's own plugins.txt marks this plugin active (the "*" prefix).
   * `null` when the plugin isn't listed in plugins.txt at all — confirmed live: game/DLC
   * masters (Skyrim.esm, Update.esm, ...) are activated implicitly by the engine and
   * never appear there, so "not listed" must NOT be treated as "inactive" or every
   * master would show as a permanent false discrepancy. (A plain JS `undefined` here
   * would be silently dropped by JSON.stringify on an object property — unlike the
   * top-level jsonText() case, this needs an explicit null to stay visible on the wire.)
   */
  activeInPluginsTxt: boolean | null;
}

/**
 * Finds plugins where Vortex's load-order state, what's actually deployed to the game's
 * Data folder, and what the game's own plugins.txt says is active all disagree — reads
 * both real files directly rather than trusting Vortex's in-memory state alone, since a
 * deploy can silently partially fail. plugins.txt lives under LOCALAPPDATA (confirmed
 * live — NOT Documents/My Games, an initial guess that was wrong), in a folder matching
 * MY_GAMES_FOLDER's name. Reports raw discrepancies only, no verdict about which source
 * is "right" — matches list_file_conflicts' stance. Only supports games with a verified
 * save-data folder name (see MY_GAMES_FOLDER).
 */
export async function findMissingDeployedFiles(
  api: IExtensionApi,
  gameId?: string,
): Promise<DeploymentDiscrepancy[]> {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const myGamesFolder = MY_GAMES_FOLDER[targetGameId];
  if (myGamesFolder === undefined) {
    throw new Error(
      `Don't know the save-data folder name for ${targetGameId}. Supported: ` +
        Object.keys(MY_GAMES_FOLDER).join(", "),
    );
  }
  const gamePath = queryStatePath(api, [
    "settings",
    "gameMode",
    "discovered",
    targetGameId,
    "path",
  ]) as string | undefined;
  if (gamePath === undefined) {
    throw new Error(`Game ${targetGameId} is not discovered (no installation path known).`);
  }
  const dataDir = path.join(gamePath, "Data");
  const localAppData = util.getVortexPath("localAppData");
  const pluginsTxtPath = path.join(localAppData, myGamesFolder, "plugins.txt");

  const pluginsTxtActive = new Map<string, { active: boolean; displayName: string }>();
  try {
    const content = await readFile(pluginsTxtPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }
      const active = line.startsWith("*");
      const plugin = active ? line.slice(1) : line;
      pluginsTxtActive.set(plugin.toLowerCase(), { active, displayName: plugin });
    }
  } catch {
    // No plugins.txt yet (never deployed/launched) — every plugin is treated as not listed.
  }

  const loadOrder = listLoadOrder(api);
  const loadOrderByLower = new Map(loadOrder.map((entry) => [entry.plugin.toLowerCase(), entry]));
  const pluginKeysLower = new Set([...loadOrderByLower.keys(), ...pluginsTxtActive.keys()]);

  const discrepancies: DeploymentDiscrepancy[] = [];
  await Promise.all(
    [...pluginKeysLower].map(async (key) => {
      const loadOrderEntry = loadOrderByLower.get(key);
      const txtEntry = pluginsTxtActive.get(key);
      const plugin = loadOrderEntry?.plugin ?? txtEntry?.displayName ?? key;
      const vortexEnabled = loadOrderEntry?.enabled ?? false;
      const activeInPluginsTxt = txtEntry?.active ?? null;
      const existsInDataFolder = await stat(path.join(dataDir, plugin))
        .then((s) => s.isFile())
        .catch(() => false);
      const mismatch =
        vortexEnabled !== existsInDataFolder ||
        (activeInPluginsTxt !== null &&
          (vortexEnabled !== activeInPluginsTxt || existsInDataFolder !== activeInPluginsTxt));
      if (mismatch) {
        discrepancies.push({ plugin, vortexEnabled, existsInDataFolder, activeInPluginsTxt });
      }
    }),
  );
  discrepancies.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return discrepancies;
}

export interface OrphanedFileMatch {
  relPath: string;
  /**
   * NOT a mod id — Vortex's deployment manifest records each file's source as the
   * owning mod's `installationPath` (staging folder name), read from Vortex's own
   * source (mod_management/LinkingDeployment.ts's activate(): `source: sourceName`
   * where sourceName is `mod.installationPath`) — found live that installationPath and
   * `id` can diverge (a mod update can keep the old id while changing installationPath,
   * or vice versa), so this can't be matched against list_mods' `id` directly.
   */
  source: string;
}

/**
 * Finds files Vortex's own deployment manifest (<Data>/vortex.deployment.json — the
 * same bookkeeping Vortex reads for its own Purge) still attributes to a mod whose
 * installationPath no longer has a corresponding entry in persistent.mods, but that are
 * still physically present in the Data folder. A join reflection can't do in one call:
 * cross-references every manifest entry's source against the current mod list, then
 * confirms the file is still really on disk (the manifest itself can be stale). This is
 * the read-side of a real, commonly-reported Vortex complaint — uninstalling a mod
 * sometimes leaves its .esp/texture files behind — surfaced via the same manifest Vortex
 * itself uses, not a heuristic file-tree diff (which can't tell a leftover mod file from
 * a legitimately manually-placed one; this can, since every Vortex-deployed file has a
 * manifest entry). Only covers the DEFAULT mod type's manifest (vortex.deployment.json,
 * no per-modType suffix) — a game using per-type mod deployment (e.g. separate save/ini
 * mod types) can have additional untyped manifests this doesn't read.
 */
export async function findOrphanedFiles(
  api: IExtensionApi,
  gameId?: string,
): Promise<OrphanedFileMatch[]> {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const gamePath = queryStatePath(api, [
    "settings",
    "gameMode",
    "discovered",
    targetGameId,
    "path",
  ]) as string | undefined;
  if (gamePath === undefined) {
    throw new Error(`Game ${targetGameId} is not discovered (no installation path known).`);
  }
  const dataDir = path.join(gamePath, "Data");
  const manifestPath = path.join(dataDir, "vortex.deployment.json");

  let manifestFiles: Array<{ relPath: string; source: string }>;
  try {
    const raw = await readFile(manifestPath, "utf8");
    manifestFiles =
      (JSON.parse(raw) as { files?: Array<{ relPath: string; source: string }> }).files ?? [];
  } catch {
    // No manifest yet (never deployed) — nothing to check.
    return [];
  }

  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const installedPaths = new Set(Object.values(mods).map((mod) => mod.installationPath));

  const orphans: OrphanedFileMatch[] = [];
  for (const file of manifestFiles) {
    if (installedPaths.has(file.source)) {
      continue;
    }
    const stillOnDisk = await stat(path.join(dataDir, file.relPath))
      .then(() => true)
      .catch(() => false);
    if (stillOnDisk) {
      orphans.push({ relPath: file.relPath, source: file.source });
    }
  }
  return orphans;
}

// api.ext.* — Vortex's own built-in extension APIs (Nexus Mods integration, using the
// user's existing Vortex login, no separate API key needed; other extensions can add
// more). Not an allowlist — see ACTION_HINTS's comment for why (the token is the real
// boundary); this map is pure documentation for the arg order of the ones this project
// has verified. Real signatures confirmed by reading Vortex's own installed app.asar
// bundle (its source map comments survive minification) rather than guessed.
const EXTENSION_API_HINTS = new Map<string, string>([
  [
    "nexusGetModInfo",
    "gameId: string, nexusModId: number — returns Partial<IModInfo>. nexusModId is the " +
      "Nexus numeric mod id, not the Vortex-internal mod id — look it up first via " +
      "vortex_query path=persistent.mods.<gameId>.<modId>.attributes.modId if you only " +
      "have the Vortex mod id.",
  ],
  [
    "nexusGetCollections",
    'gameId: string (plain positional string, e.g. args=["skyrimvr"]) — returns the ' +
      "installed/downloaded collections for that game, or null if there are none (found " +
      "live: null on a game with none, not an error).",
  ],
  [
    "lootSortAsync",
    "A SINGLE OBJECT arg (read from Vortex source, " +
      "gamebryo-plugin-management/src/index.ts registerAPI('lootSortAsync', ...)): " +
      "{pluginFilePaths: string[], onSortCallback: (err: Error, sortedPluginNames: " +
      "string[]) => void} — NOT (gameId, mods, callback) positional args. Sorts the " +
      "ACTIVE profile's plugins via LOOT (no profileId/gameId arg); pluginFilePaths is " +
      "the list of plugin file paths to sort, not just names. Prefer dispatching the " +
      "autosort-plugins event instead if you just want 'sort like the in-app Sort Now " +
      "button' — that's what the UI itself calls, and it doesn't require assembling " +
      "pluginFilePaths yourself.",
  ],
  [
    "nexusSearchCollections",
    'A single OPTIONS OBJECT, not positional args — e.g. args=[{"gameId": ' +
      '"skyrimspecialedition", "search": "vanilla"}] (confirmed working live, returned ' +
      "{nodes, totalCount}). The filter field is `search`, NOT `query` — `query` is " +
      "silently ignored (found live: no error, just an unfiltered/empty result, so a " +
      "typo'd field name is indistinguishable from a genuine no-match). `gameId` must be " +
      "the NEXUS DOMAIN NAME, not Vortex's internal gameId — they differ for most games " +
      '(Skyrim SE\'s Vortex id is "skyrimse" but its Nexus domain is ' +
      '"skyrimspecialedition"; VR titles like "skyrimvr" happen to match, which can mask ' +
      "this). There's no selector in this project for the Vortex-id-to-Nexus-domain " +
      "mapping; when in doubt, try the Vortex gameId first and fall back to the game's " +
      "known Nexus URL slug. Passing a bare string instead of an options object throws a " +
      'raw, unhelpful runtime error ("search.trim is not a function") with no indication ' +
      "the shape is wrong — this project doesn't have the exact ICollectionSearchOptions " +
      "field list (it's declared in @nexusmods/nexus-api, not vendored here), so treat " +
      "this as a starting point, not the full option set.",
  ],
]);

function getExtensionApi<T>(api: IExtensionApi, name: string): T {
  const fn = ((api.ext ?? {}) as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`${name} isn't available — the extension providing it may not be loaded.`);
  }
  return fn as T;
}

export interface ModUpdateCheckResult {
  checkedCount: number;
  /** Vortex-internal mod ids that have an update available on Nexus. */
  updatedModIds: string[];
  /**
   * How many Nexus-sourced mods were eligible to check in total (before `limit` capped
   * it). checkedCount < eligibleCount means there's more to check — pass modIds
   * explicitly (the ones not yet checked) to cover the rest in a follow-up call.
   */
  eligibleCount: number;
}

// Found live: the default (no modIds) form makes one real, rate-limited Nexus API call
// per mod through Vortex's own nexusCheckModsVersion, and reliably exceeds a 300s MCP
// call timeout well before covering a real modlist — confirmed even at 58 mods, not just
// on a huge one. There's no way to make the underlying per-mod API calls faster from
// here, so the fix is capping what one call attempts by default rather than letting the
// caller discover the timeout the hard way; DEFAULT_UPDATE_CHECK_LIMIT keeps the default
// (unscoped) form inside a safe, near-instant budget, matching the "confirmed near-
// instant on 3 mods" case already documented on the tool description.
const DEFAULT_UPDATE_CHECK_LIMIT = 25;

/**
 * Checks installed Nexus-sourced mods for available updates via Vortex's own built-in
 * integration and the user's existing Vortex login — no separate API key. Defaults to
 * the first `limit` (25) installed mods with source "nexus"; pass modIds to check a
 * specific subset instead. `limit` still applies to an explicit modIds list — the same
 * per-mod network call causes the same timeout risk regardless of who picked the ids —
 * so pass the remaining ids in a follow-up call to cover the rest. Consumes the user's
 * real Nexus API request quota — don't call this in a loop.
 */
export async function checkNexusModUpdates(
  api: IExtensionApi,
  gameId?: string,
  modIds?: string[],
  limit: number = DEFAULT_UPDATE_CHECK_LIMIT,
): Promise<ModUpdateCheckResult> {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const eligibleIds = (modIds ?? Object.keys(mods)).filter((id) => {
    const mod = mods[id];
    return (
      mod !== undefined && (mod.attributes as { source?: string } | undefined)?.source === "nexus"
    );
  });
  const cappedIds = eligibleIds.slice(0, limit);
  const targetMods = cappedIds.map((id) => mods[id]);
  const fn = getExtensionApi<
    (gameId: string, mods: IMod[], forceFull?: boolean) => Promise<string[]>
  >(api, "nexusCheckModsVersion");
  const updatedModIds = await fn(targetGameId, targetMods, false);
  return { checkedCount: targetMods.length, updatedModIds, eligibleCount: eligibleIds.length };
}

interface CollectionModRule {
  type: string;
  ignored?: boolean;
  reference: types.IModReference;
}

export interface CollectionRuleStatus {
  /** What the collection asks for, rendered the way Vortex renders it. */
  reference: string;
  /** Id of the mod satisfying it, when one does. */
  modId?: string;
  satisfied: boolean;
  /** Installed but switched off in the active profile — satisfies nothing. */
  installedButDisabled: boolean;
}

export interface CollectionStatus {
  collectionModId: string;
  name: string;
  /** Vortex's own verdict: the Collections page shows "Incomplete" when false. */
  complete: boolean;
  required: number;
  satisfied: number;
  unsatisfied: CollectionRuleStatus[];
}

/**
 * Whether a collection is installed, by Vortex's own definition.
 *
 * Counting installed mods is not that definition, and the difference is not
 * academic: a run here reported 8/8 members installed, nothing left installing
 * and no dialogs open, while Vortex's Collections page still said "Incomplete".
 *
 * Vortex resolves every non-ignored `requires` rule through `findModByRef` and
 * additionally requires the matched mod to be **enabled in the active profile**;
 * a rule whose reference matches nothing, or matches a disabled mod, counts as
 * unsatisfied. So a mod can be installed, named correctly and sitting in the mod
 * list while the rule pointing at it is still unsatisfied — because the
 * reference did not match it, or the profile has it switched off.
 *
 * `findModByRef` is Vortex's own matcher, imported rather than reimplemented:
 * its matching rules (version ranges, file hashes, logical names) are exactly
 * what decides this, and a private approximation would drift from the answer
 * the UI shows.
 */
export function collectionStatus(api: IExtensionApi, gameId?: string): CollectionStatus[] {
  const st = state(api);
  const targetGameId = resolveGameId(gameId, st);
  const mods = (st.persistent.mods?.[targetGameId] ?? {}) as Record<string, types.IMod>;
  const profile = selectors.activeProfile(st) as
    | { modState?: Record<string, { enabled?: boolean }> }
    | undefined;

  return Object.values(mods)
    .filter((mod) => mod.type === "collection")
    .map((collection) => {
      const rules = ((collection.rules ?? []) as unknown as CollectionModRule[]).filter(
        (rule) => rule.type === "requires" && rule.ignored !== true,
      );

      const statuses: CollectionRuleStatus[] = rules.map((rule) => {
        const mod = util.findModByRef(rule.reference, mods);
        const enabled = mod === undefined ? false : profile?.modState?.[mod.id]?.enabled === true;
        return {
          reference: util.renderModReference(rule.reference),
          modId: mod?.id,
          satisfied: mod !== undefined && enabled,
          installedButDisabled: mod !== undefined && !enabled,
        };
      });

      const unsatisfied = statuses.filter((s) => !s.satisfied);
      return {
        collectionModId: collection.id,
        name: util.renderModName(collection),
        complete: unsatisfied.length === 0,
        required: statuses.length,
        satisfied: statuses.length - unsatisfied.length,
        unsatisfied,
      };
    });
}
