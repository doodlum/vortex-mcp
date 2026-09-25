/**
 * Collections that install without Nexus, for testing what a completed collection
 * install leaves behind.
 *
 * A collection archive whose members are *bundled* — shipped inside the archive
 * itself — installs end to end with no download, account or network: Vortex imports
 * each bundled member from the collection's staging folder and installs it like any
 * other dependency. Everything after the install (applying its rules, deploying, the
 * gamebryo plugin postprocessing, the review screen, the state it leaves) is Vortex's
 * normal collection path.
 *
 * Vortex's own exporter lays bundled members out as `bundled/<name>/…` directories and
 * refers to each by that directory name (`fileExpression`); this writes the same shape.
 * For a Bethesda game it also writes the `plugins` list the exporter writes: without it
 * the gamebryo collection parser throws on `collection.plugins.find` and Vortex skips
 * the rest of postprocessing (plugin enabling, `collection-postprocess-complete`)
 * without a visible error.
 *
 * The archive is installed the way a downloaded collection is: registered as a download
 * first, then installed from it, so the collection mod has an `archiveId` and the
 * install driver reads revision information from that download. That is what makes the
 * game-version prompt reachable offline (`gameVersions`).
 */
import fs from "node:fs";
import path from "node:path";

import { strToU8, zipSync, type Zippable } from "fflate";

import { deployMods } from "./deployment";
import type { VortexMcpClient } from "./mcpClient";
import {
  clickInsideDialog,
  dialogButtons,
  findNodes,
  openDialogs,
  snapshot,
  type SnapshotNode,
} from "./uiDriver";

export interface CollectionPlugin {
  name: string;
  /** Whether the collection enables it; Vortex's postprocessing applies this. Default true. */
  enabled?: boolean;
}

export interface BundledMember {
  /** Display name; the bundled directory is "Bundled - <name> v<version>". */
  name: string;
  version?: string;
  /** Files of the member, relative to the mod's root. None for a member already installed. */
  files: Record<string, Uint8Array | string>;
  /** Reference tag; defaults to one derived from the name. */
  tag?: string;
  /** An optional member (a `recommends` rule), offered after the required ones. */
  optional?: boolean;
  /**
   * How the manifest refers to the member's bundle. Default: its bundle directory's name,
   * as Vortex's exporter writes it. A glob (`Bundled - x?*`) exercises Vortex's pattern
   * matching; with `files: {}` the member must already be installed, matched by its tag.
   */
  fileExpression?: string;
  /**
   * The member's plugins as the collection lists them. Default: every .esp/.esm/.esl in
   * `files`, enabled.
   */
  plugins?: CollectionPlugin[];
}

export interface OfflineCollection {
  name: string;
  /** Vortex game id, used as the manifest's domain name. */
  gameId: string;
  members: BundledMember[];
  /**
   * The collection's plugin list. Default: the members' plugins. Written whenever it is
   * non-empty, the way Vortex's exporter does for Bethesda games.
   */
  plugins?: CollectionPlugin[];
  /** Rules between members (`before`, `after`, `conflicts`, …), written as `modRules`. */
  modRules?: CollectionModRule[];
}

/** A reference in a collection's modRules: a tag, a fileExpression, a logicalFileName, … */
export type CollectionModReference = Record<string, string>;

export interface CollectionModRule {
  source: CollectionModReference;
  type: string;
  reference: CollectionModReference;
}

const bundleName = (member: BundledMember): string =>
  `Bundled - ${member.name} v${member.version ?? "1.0.0"}`;

const PLUGIN_FILE = /\.es[pml]$/i;

/** The plugins a member ships, as the collection lists them. */
export function memberPlugins(member: BundledMember): CollectionPlugin[] {
  return (
    member.plugins ??
    Object.keys(member.files)
      .filter((file) => PLUGIN_FILE.test(file) && !file.includes("/"))
      .map((name) => ({ name, enabled: true }))
  );
}

/** The collection.json Vortex's collection installer reads. */
export function collectionManifest(collection: OfflineCollection): Record<string, unknown> {
  const plugins = (collection.plugins ?? collection.members.flatMap(memberPlugins)).map((p) => ({
    name: p.name,
    enabled: p.enabled !== false,
  }));
  return {
    info: {
      author: "vortex-mcp",
      authorUrl: "",
      name: collection.name,
      description: "Offline test collection",
      installInstructions: "",
      domainName: collection.gameId,
    },
    mods: collection.members.map((member) => ({
      name: member.name,
      version: member.version ?? "1.0.0",
      optional: member.optional === true,
      domainName: collection.gameId,
      source: {
        type: "bundle",
        fileExpression: member.fileExpression ?? bundleName(member),
        updatePolicy: "exact",
        tag: member.tag ?? `vortex-mcp-${member.name}`,
      },
    })),
    modRules: collection.modRules ?? [],
    ...(plugins.length > 0 ? { plugins, pluginRules: { plugins: [], groups: [] } } : {}),
  };
}

/** Write the collection archive. */
export function writeOfflineCollection(file: string, collection: OfflineCollection): string {
  const entries: Zippable = {
    "collection.json": strToU8(JSON.stringify(collectionManifest(collection), null, 2)),
  };
  for (const member of collection.members) {
    for (const [relative, content] of Object.entries(member.files)) {
      entries[`bundled/${bundleName(member)}/${relative}`] =
        typeof content === "string" ? strToU8(content) : content;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zipSync(entries));
  return file;
}

export interface AddCollectionOptions {
  timeoutMs?: number;
  /**
   * Revision information for the download, as Nexus would supply it, so the install driver
   * treats this as a revision. Only needed for the game-version prompt: the driver shows
   * "Game version mismatch" when the installed game's version is not among these.
   * Setting it makes the driver dispatch its pending-vote bookkeeping for `revisionId` too.
   */
  gameVersions?: string[];
  /** Revision id stamped on the download with `gameVersions`. Default 1. */
  revisionId?: number;
  /**
   * `download` (default): register the archive as a download and install from it, as a
   * collection downloaded from Nexus is. `file`: the older `start-install <path>`, which
   * leaves the collection with no `archiveId`, so no revision information or game-version
   * prompt.
   */
  via?: "download" | "file";
}

export interface AddedCollection {
  collectionModId: string;
  /** The download the collection was installed from; undefined with `via: "file"`. */
  downloadId?: string;
  /** The Install Now dialog's text, for `clickInsideDialog`. */
  dialog?: string;
}

/**
 * Wait for the collection's Install Now dialog and return its text. Polled with
 * `ui_active_dialogs`, not a full snapshot: with a few hundred mods on the Mods page a full
 * snapshot reaches its node limit before the modal, which is rendered last, so its buttons are
 * never in it (KNOWLEDGE.md, "the snapshot's node limit").
 */
export async function waitForInstallNow(mcp: VortexMcpClient, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  for (;;) {
    const dialogs = await openDialogs(mcp);
    if (dialogs !== undefined) {
      last = dialogs;
      // Buttons' text runs together ("LaterInstall Now"), so no word boundary before it. And
      // the text is cut at 400 characters with Install Now last, so a long description drops
      // it; the heading ("<game> collection added") comes first.
      const found = dialogs.find(
        (d) =>
          (/collection added/i.test(d) || /install now\b/i.test(d)) &&
          !/collection installation (complete|incomplete)/i.test(d),
      );
      if (found !== undefined) return found;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No Install Now dialog within ${String(timeoutMs)}ms. Open dialogs: ` +
          `${last.map((d) => d.slice(0, 80)).join(" | ") || "none"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Put an offline collection into Vortex up to its Install Now dialog: register the archive as
 * a download of the active game, stamp any revision information on it, and install the
 * collection mod from it.
 */
export async function addOfflineCollection(
  mcp: VortexMcpClient,
  archive: string,
  options: AddCollectionOptions = {},
): Promise<AddedCollection> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  let collectionModId: unknown;
  let downloadId: string | undefined;
  if (options.via === "file") {
    if (options.gameVersions !== undefined) {
      throw new Error('gameVersions needs a download to stamp them on; omit via: "file".');
    }
    collectionModId = await mcp.call<string>(
      "vortex_dispatch",
      { action: "start-install", args: [path.resolve(archive), "__CALLBACK__"] },
      timeoutMs,
    );
  } else {
    const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
    if (!gameId) throw new Error("Manage a game before adding a collection.");
    const downloads = await mcp.call<string>("vortex_query", {
      selector: "downloadPathForGame",
      args: [gameId],
    });
    fs.mkdirSync(downloads, { recursive: true });
    // A name per add: a download of the same name is the same file to Vortex.
    const stamp = `${String(Date.now())}${String(Math.floor(Math.random() * 1000))}`;
    const fileName = `${path.basename(archive, path.extname(archive))}-${stamp}${path.extname(archive)}`;
    fs.copyFileSync(archive, path.join(downloads, fileName));
    downloadId = `vortex-mcp-collection-${stamp}`;
    await mcp.call("vortex_dispatch", {
      action: "addLocalDownload",
      args: [downloadId, gameId, fileName, fs.statSync(archive).size],
    });
    if (options.gameVersions !== undefined) {
      await setRevisionInfo(mcp, downloadId, options.revisionId ?? 1, options.gameVersions);
    }
    // What Vortex does itself when a collection download finishes (did-download-collection);
    // the bare `false` is the allowAutoEnable flag every Vortex version accepts.
    collectionModId = await mcp.call<string>(
      "vortex_dispatch",
      { action: "start-install-download", args: [downloadId, false, "__CALLBACK__"] },
      timeoutMs,
    );
  }
  if (typeof collectionModId !== "string") {
    throw new Error("Vortex did not return the collection's mod id.");
  }
  return { collectionModId, downloadId, dialog: await waitForInstallNow(mcp) };
}

/**
 * Stamp Nexus-style revision information on a collection's download. With
 * `revisionInfo.modFiles` present the driver uses it instead of asking Nexus.
 */
export async function setRevisionInfo(
  mcp: VortexMcpClient,
  downloadId: string,
  revisionId: number,
  gameVersions: string[],
): Promise<void> {
  await mcp.call("vortex_dispatch", {
    action: "setDownloadModInfo",
    args: [downloadId, "nexus.ids.revisionId", revisionId],
  });
  await mcp.call("vortex_dispatch", {
    action: "setDownloadModInfo",
    args: [
      downloadId,
      "nexus.revisionInfo",
      { modFiles: [], gameVersions: gameVersions.map((reference) => ({ reference })) },
    ],
  });
}

/** A version no real game reports, for `gameVersions` when the prompt must appear. */
export const MISMATCHED_GAME_VERSION = "0.0.0-vortex-mcp-mismatch";

/**
 * Wait for the "Game version mismatch" prompt and answer it. Returns the dialog's text, or
 * undefined when it did not appear within the timeout.
 */
export async function answerGameVersionPrompt(
  mcp: VortexMcpClient,
  answer: "continue" | "cancel",
  timeoutMs = 30_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const prompt = ((await openDialogs(mcp)) ?? []).find((d) => /game version mismatch/i.test(d));
    if (prompt !== undefined) {
      await clickInsideDialog(mcp, prompt, answer === "cancel" ? /^cancel$/i : /^continue$/i);
      return prompt;
    }
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export interface CollectionInstallResult {
  collectionModId: string;
  downloadId?: string;
  /** The button that closed the review screen. */
  closedWith: string;
  /** The review's title: complete, or incomplete (a required member failed). */
  outcome: "complete" | "incomplete";
  /**
   * Whether Vortex emitted `collection-postprocess-complete` for this collection, which it
   * does only after every postprocessing step (rules, deploy, game specifics) finished.
   * Undefined when the extension cannot subscribe to plain events (an older build).
   */
  postprocessed?: boolean;
  /** The game-version prompt's text, when it appeared. */
  gameVersionPrompt?: string;
}

/**
 * Points in `installOfflineCollection`, for a caller that timestamps them (collection-scale
 * marks them in its CPU profile). `review-shown` comes again after an optionals pass.
 */
export type CollectionPhase =
  | "install-now"
  | "game-version-answered"
  | "review-shown"
  | "optionals-install"
  | "optionals-stand-in"
  | "review-closing"
  | "review-closed";

export interface InstallCollectionOptions extends AddCollectionOptions {
  /**
   * At the review: skip the optional members (No Thanks, default) or install them. `stand-in`
   * clicks Install optional mods and then completes that pass without installing anything
   * (`completeOptionalsWithoutInstall`), because bundled optional installs stall.
   */
  optionals?: "skip" | "install" | "stand-in";
  /** Called at each phase, awaited, before the step it names happens (after, for `-closed`). */
  onPhase?: (phase: CollectionPhase, detail?: string) => void | Promise<void>;
  /** Answer to the game-version prompt, when `gameVersions` makes it appear. Default continue. */
  gameVersionAnswer?: "continue" | "cancel";
  /** Close an "incomplete" review with Close instead of failing. */
  allowIncomplete?: boolean;
}

/**
 * Install an offline collection all the way through its review screen, the way a user
 * does: add it, click Install Now, answer the game-version prompt if asked, wait for the
 * review and close it. Waiting for the button and not for state is deliberate: the
 * review's close is where Vortex finishes (or fails to finish) tearing the install down.
 */
export async function installOfflineCollection(
  mcp: VortexMcpClient,
  archive: string,
  options: InstallCollectionOptions = {},
): Promise<CollectionInstallResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const events = await watchEvent(mcp, "collection-postprocess-complete");
  const added = await addOfflineCollection(mcp, archive, options);
  await options.onPhase?.("install-now");
  await clickInsideDialog(mcp, added.dialog ?? (await waitForInstallNow(mcp)), /^install now$/i);

  let gameVersionPrompt: string | undefined;
  if (options.gameVersions !== undefined) {
    gameVersionPrompt = await answerGameVersionPrompt(mcp, options.gameVersionAnswer ?? "continue");
    if (gameVersionPrompt !== undefined) {
      await options.onPhase?.("game-version-answered", options.gameVersionAnswer ?? "continue");
    }
    if (gameVersionPrompt === undefined) {
      throw new Error(
        'gameVersions was set but no "Game version mismatch" prompt appeared. The installed ' +
          "game may report one of those versions.",
      );
    }
    if (options.gameVersionAnswer === "cancel") {
      return {
        ...added,
        closedWith: "Cancel (game-version prompt)",
        outcome: "incomplete",
        gameVersionPrompt,
      };
    }
  }

  const review = await closeReview(mcp, added.collectionModId, options, timeoutMs);
  let postprocessed: boolean | undefined;
  if (events !== undefined) {
    // Emitted before the review's buttons enable; give a straggler a moment.
    const deadline = Date.now() + 10_000;
    do {
      postprocessed = (await events.since()).some((args) => args[1] === added.collectionModId);
      if (postprocessed) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
  }
  return { ...added, ...review, postprocessed, gameVersionPrompt };
}

async function closeReview(
  mcp: VortexMcpClient,
  collectionModId: string,
  options: InstallCollectionOptions,
  timeoutMs: number,
): Promise<{ closedWith: string; outcome: "complete" | "incomplete" }> {
  // The review's buttons are disabled while postprocessing; clicking waits for them enabled.
  const closeButton = /^(done|close|no thanks)$/i;
  let installedOptionals = false;
  const deadline = Date.now() + timeoutMs;
  let lastDialogs: string[] = [];
  let shown = false;
  let closing = false;
  // Polls of the review without an Install optional mods button, while optionals are wanted.
  let withoutOptionals = 0;
  for (;;) {
    // A large collection blocks the renderer for seconds at a time while it resolves and
    // postprocesses its members, and the MCP server lives in the renderer: a request can
    // fail mid-block. That is the collection being slow, not finished or broken; retry.
    const dialogs = await openDialogs(mcp);
    if (dialogs !== undefined) {
      lastDialogs = dialogs;
      const review = dialogs.find((d) => /collection installation (complete|incomplete)/i.test(d));
      if (review === undefined) {
        shown = false;
      } else {
        if (!shown) {
          shown = true;
          await options.onPhase?.("review-shown");
        }
        const outcome = /incomplete/i.test(review) ? "incomplete" : "complete";
        if (outcome === "incomplete" && options.allowIncomplete !== true) {
          throw new Error(
            `The collection finished incomplete (a required member failed): ${review.slice(0, 300)}`,
          );
        }
        // Scoped to the dialog: a page-wide lookup finds more than one "Done".
        // Optionals are wanted until the review, ready (a close button enabled), has shown no
        // Install optional mods button for three polls. The buttons are looked at, not the
        // dialog's text, which is cut at 400 characters before them; and a button disabled
        // while the review postprocesses is not an absent one.
        let wantOptionals =
          (options.optionals === "install" || options.optionals === "stand-in") &&
          !installedOptionals &&
          withoutOptionals < 3;
        let clicked: string | undefined;
        let wantsOptionals = false;
        if (wantOptionals) {
          const buttons = await dialogButtons(mcp, review).catch(() => undefined);
          const offer = buttons?.find((b) => /^install optional mods$/i.test(b.name));
          const ready = buttons?.some((b) => closeButton.test(b.name) && !b.disabled) === true;
          if (offer !== undefined && !offer.disabled) {
            clicked = await clickInsideDialog(mcp, review, /^install optional mods$/i, {
              required: false,
            }).catch(() => undefined);
            wantsOptionals = clicked !== undefined;
            if (wantsOptionals) await options.onPhase?.("optionals-install");
          } else if (offer === undefined && ready && ++withoutOptionals >= 3) {
            wantOptionals = false;
          }
        }
        if (!wantOptionals) {
          if (!closing) {
            closing = true;
            await options.onPhase?.("review-closing");
          }
          clicked = await clickInsideDialog(
            mcp,
            review,
            closeButton,
            // Polled: the review's buttons render a moment after its text.
            { required: false },
          ).catch(() => undefined);
        }
        if (clicked !== undefined && wantsOptionals) {
          // The optional members install, then the review comes back.
          installedOptionals = true;
          shown = false;
          closing = false;
          if (options.optionals === "stand-in") {
            await options.onPhase?.("optionals-stand-in");
            await completeOptionalsWithoutInstall(mcp, collectionModId);
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        } else if (clicked !== undefined) {
          await options.onPhase?.("review-closed", clicked);
          return { closedWith: clicked, outcome };
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The collection did not reach its review screen within ${String(timeoutMs)}ms. ` +
          `Open dialogs: ${lastDialogs.join(" | ") || "none"}. ` +
          "`vortex-ai call collection_install_state` shows the driver's step and the session.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Subscribe to a plain Vortex event through the extension's `onEvent` listener and read what
 * arrived after now. Undefined when the extension has no `onEvent` (an older build).
 */
export async function watchEvent(
  mcp: VortexMcpClient,
  event: string,
): Promise<{ since: () => Promise<unknown[][]> } | undefined> {
  let listenerId: string;
  try {
    ({ listenerId } = await mcp.call<{ listenerId: string }>("vortex_dispatch", {
      action: "onEvent",
      args: [event, "__CALLBACK__"],
    }));
  } catch {
    return undefined;
  }
  // The listener is shared per event; only what arrives from here on counts.
  const { lastSeq } = await mcp.call<{ lastSeq: number }>("poll_listener", { listenerId });
  return {
    since: async () =>
      (
        await mcp.call<{ entries: { args: unknown[] }[] }>("poll_listener", {
          listenerId,
          since: lastSeq,
        })
      ).entries.map((e) => e.args),
  };
}

export interface UpdateCollectionOptions extends InstallCollectionOptions {
  /** Old-revision members to remove with the old collection mod ("Remove"/"Review" answers). */
  remove?: string[];
  /** Old-revision members to keep as individually installed mods ("Keep All"). */
  keep?: string[];
}

export interface CollectionUpdateResult {
  /** Time to remove the old revision's collection mod (and `remove`). */
  removeMs: number;
  /** The new revision's install, from Install Now through its review. */
  install: CollectionInstallResult;
}

/**
 * Update an installed offline collection to a new revision the way Vortex's
 * `collectionUpdate` (collections/eventHandlers.ts) does once the new revision is
 * downloaded: mark kept members as installed individually, remove the old collection mod
 * (and any members being removed) with `remove-mods` and reason `collection_update`, keeping
 * every other member installed, then install the new revision from its download. Members
 * the two revisions share are then already installed, so the install resolves them rather
 * than installing them again.
 *
 * Not reproduced: the changelog dialog, the "Remove mods from old revision?" question
 * (pass its answer as `remove`/`keep`), and re-enabling optional members that were enabled
 * before the update.
 */
export async function updateOfflineCollection(
  mcp: VortexMcpClient,
  previousCollectionModId: string,
  archive: string,
  options: UpdateCollectionOptions = {},
): Promise<CollectionUpdateResult> {
  const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
  if (!gameId) throw new Error("Manage a game before updating a collection.");
  for (const modId of options.keep ?? []) {
    await mcp.call("vortex_dispatch", {
      action: "setModAttribute",
      args: [gameId, modId, "installedAsDependency", false],
    });
  }
  const started = Date.now();
  await mcp.call(
    "vortex_dispatch",
    {
      action: "remove-mods",
      args: [
        gameId,
        [previousCollectionModId, ...(options.remove ?? [])],
        "__CALLBACK__",
        { incomplete: true, ignoreInstalling: true, reason: "collection_update" },
      ],
    },
    options.timeoutMs ?? 600_000,
  );
  const removeMs = Date.now() - started;
  const install = await installOfflineCollection(mcp, archive, options);
  return { removeMs, install };
}

// ---------------------------------------------------------------------------
// Driving a collection without its Nexus-only paths
// ---------------------------------------------------------------------------

interface CollectionRule {
  type?: string;
  ignored?: boolean;
  reference?: { tag?: string; description?: string; logicalFileName?: string };
}

interface StateMod {
  id?: string;
  type?: string;
  state?: string;
  rules?: CollectionRule[];
  attributes?: { name?: string; referenceTag?: string; referenceTags?: string[] };
}

/** The mod a tag belongs to: its referenceTag or one of its referenceTags. */
export function modWithTag(mods: Record<string, StateMod>, tag: string): string | undefined {
  return Object.entries(mods).find(
    ([, mod]) =>
      mod?.attributes?.referenceTag === tag || (mod?.attributes?.referenceTags ?? []).includes(tag),
  )?.[0];
}

/** Mod ids for optional members that stand in for installed ones; stable per tag. */
export const standInModId = (tag: string): string =>
  `vortex-mcp-optional-${tag.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * The records `completeOptionalsWithoutInstall` adds: one installed mod per optional
 * (`recommends`) rule of the collection that no installed mod carries the tag of.
 */
export function standInOptionals(
  collection: StateMod,
  mods: Record<string, StateMod>,
): Array<{ id: string; tag: string; name: string }> {
  const out: Array<{ id: string; tag: string; name: string }> = [];
  for (const rule of collection.rules ?? []) {
    const tag = rule.reference?.tag;
    if (rule.type !== "recommends" || tag === undefined) continue;
    if (modWithTag(mods, tag) !== undefined || out.some((o) => o.tag === tag)) continue;
    const name = rule.reference?.description ?? rule.reference?.logicalFileName ?? tag;
    out.push({ id: standInModId(tag), tag, name });
  }
  return out;
}

export interface OptionalsStandIn {
  /** Mods added for the optional members, installed and enabled. */
  added: string[];
  /** Session entries of optional members marked installed. */
  marked: number;
  sessionId?: string;
}

/**
 * Complete a collection's optionals pass without installing anything, after "Install optional
 * mods" was clicked. Bundled optional members that are then really installed have stalled in QA
 * until Vortex's stall watchdog fired (5 min); this stands in for that install, the way QA of the
 * review screen did:
 *
 *   1. adds an installed, enabled mod carrying each optional rule's tag, for every optional
 *      member no installed mod has (with an empty staging folder);
 *   2. marks the install session's optional entries installed
 *      (`COLLECTION_UPDATE_MOD_STATUS`);
 *   3. emits `did-install-dependencies` with recommendations true, as the optionals pass does
 *      when it ends (unless `emit: false`).
 *
 * InstallDriver then returns to the review screen by itself. What is skipped is the install
 * itself: no archive is extracted and no member's own files exist. Use it to test what happens
 * around the optionals pass (the review's re-entry, its fade, its lists), never the install.
 */
export async function completeOptionalsWithoutInstall(
  mcp: VortexMcpClient,
  collectionModId: string,
  options: { emit?: boolean } = {},
): Promise<OptionalsStandIn> {
  const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
  if (!gameId) throw new Error("Manage a game before completing a collection's optionals.");
  const mods =
    (await mcp.call<Record<string, StateMod> | null>("vortex_query", {
      path: ["persistent", "mods", gameId],
    })) ?? {};
  const collection = mods[collectionModId];
  if (collection === undefined) throw new Error(`No collection mod ${collectionModId}.`);
  const standIns = standInOptionals(collection, mods);
  if (standIns.length > 0) {
    const staging = await mcp.call<string>("vortex_query", {
      selector: "installPathForGame",
      args: [gameId],
    });
    for (const s of standIns) fs.mkdirSync(path.join(staging, s.id), { recursive: true });
    const installTime = new Date().toISOString();
    await mcp.call("vortex_dispatch", {
      action: "addMods",
      args: [
        gameId,
        standIns.map((s) => ({
          id: s.id,
          state: "installed",
          type: "",
          installationPath: s.id,
          attributes: {
            name: s.name,
            version: "1.0.0",
            installTime,
            referenceTag: s.tag,
            referenceTags: [s.tag],
          },
        })),
      ],
    });
    const profile = await mcp.call<{ id: string }>("vortex_query", { selector: "activeProfile" });
    await mcp.call("set_mods_enabled", {
      modIds: standIns.map((s) => s.id),
      enabled: true,
      profileId: profile.id,
      expectedActiveProfileId: profile.id,
    });
  }
  const session = await mcp.call<{
    sessionId?: string;
    mods?: Record<string, { type?: string; status?: string }>;
  } | null>("vortex_query", { path: ["session", "collections", "activeSession"] });
  let marked = 0;
  for (const [ruleId, entry] of Object.entries(session?.mods ?? {})) {
    if (entry?.type !== "recommends" || entry.status === "installed") continue;
    await mcp.call("vortex_dispatch", {
      action: "type:COLLECTION_UPDATE_MOD_STATUS",
      args: [{ sessionId: session?.sessionId, ruleId, status: "installed" }],
    });
    marked++;
  }
  if (options.emit !== false) {
    await mcp.call("vortex_dispatch", {
      action: "did-install-dependencies",
      args: [gameId, collectionModId, true],
    });
  }
  return { added: standIns.map((s) => s.id), marked, sessionId: session?.sessionId };
}

export interface ResumeResult {
  /** The "Collection incomplete" notification's id. */
  notificationId: string;
  /** Its message: the collection's name. */
  message?: string;
}

/**
 * Start (or resume) a collection's install from its "Collection incomplete" notification, the
 * only path to `InstallDriver.start` that works offline. `resume-collection` and the Premium
 * restart need a Nexus login, and Install Now goes through `query` instead.
 *
 * It enables the collection mod and deploys, so the dependency check reports its unfulfilled
 * rules and the collections extension raises the notification, then clicks that notification's
 * Resume. Limits: Vortex raises that notification once per collection per session (a module
 * `reported` set), so a second call for the same collection needs a restart; and it deploys,
 * so sandboxes only.
 */
export async function resumeViaNotification(
  mcp: VortexMcpClient,
  collectionModId: string,
  options: { timeoutMs?: number } = {},
): Promise<ResumeResult> {
  const gameId = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
  if (!gameId) throw new Error("Manage a game before resuming a collection.");
  const profileId = await mcp.call<string>("vortex_query", { selector: "activeProfileId" });
  await mcp.call("vortex_dispatch", {
    action: "setModEnabled",
    args: [profileId, collectionModId, true],
  });
  await deployMods(mcp, gameId);
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let notification: { id: string; message?: string } | undefined;
  for (;;) {
    const list =
      await mcp.call<Array<{ id: string; title?: string; message?: string }>>("list_notifications");
    notification = list.find((n) => n.id.includes(collectionModId));
    if (notification !== undefined) break;
    if (Date.now() > deadline) {
      throw new Error(
        `No "Collection incomplete" notification for ${collectionModId} after deploying. Vortex ` +
          "raises it once per collection per session, and only while a required member is " +
          `missing. Notifications: ${list.map((n) => n.id).join(", ") || "none"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const found = notification;
  const wanted = ["Collection incomplete", ...(found.message === undefined ? [] : [found.message])];
  let opened = false;
  const clickDeadline = Date.now() + 15_000;
  for (;;) {
    // Classic layout: each notification is a `.notification` toast.
    for (let index = 0; index < 20; index++) {
      const snap = await snapshot(mcp, ".notification", index).catch(() => undefined);
      if (snap === undefined || snap.nodeCount === 0) break;
      const resume = buttonInEntry(snap.tree, wanted, /^resume$/i);
      if (resume !== undefined) {
        await mcp.call("ui_click", { ref: resume.ref });
        return { notificationId: found.id, message: found.message };
      }
    }
    // Modern layout: they live in a popover the title bar's Notifications button opens.
    const panel = await snapshot(mcp, ".nxm-popover-panel", 0).catch(() => undefined);
    const resume = panel === undefined ? undefined : buttonInEntry(panel.tree, wanted, /^resume$/i);
    if (resume !== undefined) {
      await mcp.call("ui_click", { ref: resume.ref });
      // The entry is dismissed; close the popover if it stayed open.
      await mcp.call("ui_press_key", { key: "Escape" }).catch(() => undefined);
      return { notificationId: found.id, message: found.message };
    }
    if (!opened) {
      opened = await openNotificationCenter(mcp);
      if (opened) continue;
    }
    if (Date.now() > clickDeadline) {
      throw new Error(
        `The notification ${found.id} is listed but no Resume button for it is on screen ` +
          "(neither a .notification toast nor the Notifications popover).",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Click the title bar's Notifications button (modern layout); false when there is none. */
async function openNotificationCenter(mcp: VortexMcpClient): Promise<boolean> {
  const snap = await snapshot(mcp).catch(() => undefined);
  const button =
    snap === undefined
      ? undefined
      : findNodes(snap, { role: "button", name: /^notifications$/i })[0];
  if (button === undefined) return false;
  await mcp.call("ui_click", { ref: button.ref });
  await new Promise((resolve) => setTimeout(resolve, 500));
  return true;
}

/** Text for matching: Vortex puts zero-width spaces between a name's words. */
const normal = (text: string): string =>
  text
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const subtreeText = (node: SnapshotNode): string =>
  normal([node.name ?? "", node.text ?? "", ...(node.children ?? []).map(subtreeText)].join(" "));

const buttonIn = (node: SnapshotNode, button: RegExp): SnapshotNode | undefined =>
  findNodes({ tree: [node] } as unknown as Parameters<typeof findNodes>[0], {
    role: "button",
    name: button,
  })[0];

/**
 * One notification's button (its own Resume, when several offer one): in the smallest subtree
 * whose text holds every one of `texts`, or, where a scoped snapshot has flattened the entries
 * into siblings (it keeps only named nodes), the first such button after the sibling holding
 * the last of `texts`, all of them having appeared by then. Zero-width spaces are ignored.
 */
export function buttonInEntry(
  nodes: SnapshotNode[],
  texts: string[],
  button: RegExp,
): SnapshotNode | undefined {
  const wanted = texts.map(normal);
  for (const node of nodes) {
    const deeper = buttonInEntry(node.children ?? [], texts, button);
    if (deeper !== undefined) return deeper;
    const text = subtreeText(node);
    if (!wanted.every((t) => text.includes(t))) continue;
    const found = buttonIn(node, button);
    if (found !== undefined) return found;
  }
  const last = wanted.at(-1);
  if (last === undefined) return undefined;
  const siblings = nodes.map(subtreeText);
  for (let i = 0; i < nodes.length; i++) {
    if (!(siblings[i] ?? "").includes(last)) continue;
    const upTo = siblings.slice(0, i + 1).join(" ");
    if (!wanted.every((t) => upTo.includes(t))) continue;
    for (let j = i; j < nodes.length; j++) {
      const found = buttonIn(nodes[j]!, button);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Open review screens that `collection_install_state` attributes to this collection. */
export async function reviewDialogsFor(
  mcp: VortexMcpClient,
  collectionModId: string,
): Promise<number> {
  const state = await mcp.call<{
    dialogs?: Array<{ step?: string | null; collectionId?: string | null }>;
  }>("collection_install_state");
  return (state.dialogs ?? []).filter(
    (d) => d.step === "review" && d.collectionId === collectionModId,
  ).length;
}
