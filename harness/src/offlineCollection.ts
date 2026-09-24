/**
 * Collections that install without Nexus, for testing what a completed collection
 * install leaves behind.
 *
 * A collection archive whose members are *bundled* — shipped inside the archive
 * itself — installs end to end with no download, account or network: Vortex imports
 * each bundled member from the collection's staging folder and installs it like any
 * other dependency. Everything after the install (applying its rules, deploying, the
 * review screen, the state it leaves) is Vortex's normal collection path.
 *
 * Vortex's own exporter lays bundled members out as `bundled/<name>/…` directories and
 * refers to each by that directory name (`fileExpression`); this writes the same shape.
 */
import fs from "node:fs";
import path from "node:path";

import { strToU8, zipSync, type Zippable } from "fflate";

import type { VortexMcpClient } from "./mcpClient";
import { clickByName, clickInsideDialog, openDialogs, waitForNode } from "./uiDriver";

export interface BundledMember {
  /** Display name; the bundled directory is "Bundled - <name> v<version>". */
  name: string;
  version?: string;
  /** Files of the member, relative to the mod's root. None for a member already installed. */
  files: Record<string, Uint8Array | string>;
  /** Reference tag; defaults to one derived from the name. */
  tag?: string;
}

export interface OfflineCollection {
  name: string;
  /** Vortex game id, used as the manifest's domain name. */
  gameId: string;
  members: BundledMember[];
}

const bundleName = (member: BundledMember): string =>
  `Bundled - ${member.name} v${member.version ?? "1.0.0"}`;

/** The collection.json Vortex's collection installer reads. */
export function collectionManifest(collection: OfflineCollection): Record<string, unknown> {
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
      optional: false,
      domainName: collection.gameId,
      source: {
        type: "bundle",
        fileExpression: bundleName(member),
        updatePolicy: "exact",
        tag: member.tag ?? `vortex-mcp-${member.name}`,
      },
    })),
    modRules: [],
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

export interface CollectionInstallResult {
  collectionModId: string;
  /** The button that closed the review screen. */
  closedWith: string;
}

/**
 * Install an offline collection all the way through its review screen, the way a user
 * does: start the install, click Install Now, wait for "Collection installation
 * complete", and close it. Waiting for the button and not for state is deliberate: the
 * review's close is where Vortex finishes (or fails to finish) tearing the install down.
 */
export async function installOfflineCollection(
  mcp: VortexMcpClient,
  archive: string,
  options: { timeoutMs?: number } = {},
): Promise<CollectionInstallResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const collectionModId = await mcp.call<string>(
    "vortex_dispatch",
    { action: "start-install", args: [path.resolve(archive), "__CALLBACK__"] },
    timeoutMs,
  );
  if (typeof collectionModId !== "string") {
    throw new Error("Vortex did not return the collection's mod id.");
  }

  await waitForNode(mcp, { role: "button", name: /^install now$/i }, 60_000);
  await clickByName(mcp, { role: "button", name: /^install now$/i });

  // The review's close button is disabled while postprocessing; wait for it enabled.
  const closeButton = /^(done|close|no thanks)$/i;
  const deadline = Date.now() + timeoutMs;
  let lastDialogs: string[] = [];
  for (;;) {
    // A large collection blocks the renderer for seconds at a time while it resolves and
    // postprocesses its members, and the MCP server lives in the renderer: a request can
    // fail mid-block. That is the collection being slow, not finished or broken; retry.
    const dialogs = await openDialogs(mcp);
    if (dialogs !== undefined) {
      lastDialogs = dialogs;
      const review = dialogs.find((d) => /collection installation complete/i.test(d));
      if (review !== undefined) {
        // Scoped to the dialog: a page-wide lookup finds more than one "Done".
        const clicked = await clickInsideDialog(mcp, review, closeButton).catch(() => undefined);
        if (clicked !== undefined) return { collectionModId, closedWith: clicked };
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The collection did not reach its review screen within ${String(timeoutMs)}ms. ` +
          `Open dialogs: ${lastDialogs.join(" | ") || "none"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
