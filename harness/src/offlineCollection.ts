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

import type { VortexMcpClient } from "./mcpClient";
import { clickByName, clickInsideDialog, openDialogs, waitForNode } from "./uiDriver";

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
  await waitForNode(mcp, { role: "button", name: /^install now$/i }, 60_000);
  return { collectionModId, downloadId };
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

export interface InstallCollectionOptions extends AddCollectionOptions {
  /** At the review: skip the optional members (No Thanks, default) or install them. */
  optionals?: "skip" | "install";
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
  await clickByName(mcp, { role: "button", name: /^install now$/i });

  let gameVersionPrompt: string | undefined;
  if (options.gameVersions !== undefined) {
    gameVersionPrompt = await answerGameVersionPrompt(mcp, options.gameVersionAnswer ?? "continue");
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

  const review = await closeReview(mcp, options, timeoutMs);
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
  options: InstallCollectionOptions,
  timeoutMs: number,
): Promise<{ closedWith: string; outcome: "complete" | "incomplete" }> {
  // The review's buttons are disabled while postprocessing; clicking waits for them enabled.
  const closeButton = /^(done|close|no thanks)$/i;
  let installedOptionals = false;
  const deadline = Date.now() + timeoutMs;
  let lastDialogs: string[] = [];
  for (;;) {
    // A large collection blocks the renderer for seconds at a time while it resolves and
    // postprocesses its members, and the MCP server lives in the renderer: a request can
    // fail mid-block. That is the collection being slow, not finished or broken; retry.
    const dialogs = await openDialogs(mcp);
    if (dialogs !== undefined) {
      lastDialogs = dialogs;
      const review = dialogs.find((d) => /collection installation (complete|incomplete)/i.test(d));
      if (review !== undefined) {
        const outcome = /incomplete/i.test(review) ? "incomplete" : "complete";
        if (outcome === "incomplete" && options.allowIncomplete !== true) {
          throw new Error(
            `The collection finished incomplete (a required member failed): ${review.slice(0, 300)}`,
          );
        }
        // Scoped to the dialog: a page-wide lookup finds more than one "Done".
        const wantsOptionals =
          options.optionals === "install" &&
          !installedOptionals &&
          /install optional mods/i.test(review);
        const clicked = await clickInsideDialog(
          mcp,
          review,
          wantsOptionals ? /^install optional mods$/i : closeButton,
          // Polled: the review's buttons render a moment after its text.
          { required: false },
        ).catch(() => undefined);
        if (clicked !== undefined && wantsOptionals) {
          // The optional members install, then the review comes back.
          installedOptionals = true;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        } else if (clicked !== undefined) {
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
