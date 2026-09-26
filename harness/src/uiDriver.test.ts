import { describe, expect, it } from "vitest";

import { McpError, type VortexMcpClient } from "./mcpClient";
import {
  DialogClickError,
  clickByName,
  advanceFomod,
  clickInsideDialog,
  findNodes,
  findOne,
  autoAnswerDialogs,
  DEFAULT_DIALOG_POLICIES,
  dialogPolicies,
  snapshotIsDialog,
  type Snapshot,
  type SnapshotNode,
} from "./uiDriver";

function node(name: string, overrides: Partial<SnapshotNode> = {}): SnapshotNode {
  return { ref: `ref-${name}`, role: "button", name, ...overrides };
}

function snapshotOf(nodes: SnapshotNode[]): Snapshot {
  return {
    generation: 1,
    title: "Vortex",
    viewport: { width: 1280, height: 800 },
    nodeCount: nodes.length,
    truncated: false,
    activeDialogs: [],
    tree: nodes,
  };
}

/**
 * A client that answers ui_snapshot from a per-selector script and records the
 * clicks. Keyed by selector so a test can prove which subtree was asked for,
 * which is the part that matters: the scoping is the safety property.
 */
function fakeMcp(bySelector: Record<string, SnapshotNode[]>): {
  mcp: VortexMcpClient;
  clicked: string[];
  selectors: string[];
} {
  const clicked: string[] = [];
  const selectors: string[] = [];
  const mcp = {
    call: (name: string, args: Record<string, unknown> = {}) => {
      if (name === "ui_snapshot") {
        const selector = String(args["selector"] ?? "");
        selectors.push(selector);
        return Promise.resolve(snapshotOf(bySelector[selector] ?? []));
      }
      if (name === "ui_click") {
        clicked.push(String(args["ref"]));
        return Promise.resolve(undefined);
      }
      throw new Error(`unexpected tool call: ${name}`);
    },
  } as unknown as VortexMcpClient;
  return { mcp, clicked, selectors };
}

const NAV = "#fomod-installer-dialog .fomod-nav-buttons";

describe("target matching", () => {
  it("clicks within a panel even when a page-wide snapshot omits the target", async () => {
    const selector = '[aria-label="Plugins panel"]';
    const { mcp, clicked, selectors } = fakeMcp({
      "": [node("Mods")],
      [selector]: [node("Close Plugins panel")],
    });
    await clickByName(mcp, { role: "button", name: "Close Plugins panel" }, { selector });
    expect(selectors).toEqual([selector]);
    expect(clicked).toEqual(["ref-Close Plugins panel"]);
  });
  it("does not select Save games when asked for Games", () => {
    expect(findNodes(snapshotOf([node("Save games")]), { name: "Games" })).toEqual([]);
  });
  it("applies anchored patterns to labels without duplicating name and text", () => {
    expect(
      findNodes(snapshotOf([node("Manage", { text: "Manage" })]), { name: /^manage$/i }),
    ).toHaveLength(1);
  });
  it("requires disambiguation instead of clicking the first duplicate", () => {
    expect(() => findOne(snapshotOf([node("Close"), node("Close")]), { name: "Close" })).toThrow(
      /ambiguous/i,
    );
  });
});

describe("advanceFomod", () => {
  it("clicks the last nav button, whatever the step happens to call it", async () => {
    // Vortex labels the forward action after the step, so it is "Default
    // Settings" on one mod and "Next" on the next. Matching on the label is
    // what stalled a collection install at 8 of 12 mods.
    for (const label of ["Next", "Install", "Finish", "Default Settings", "Installation"]) {
      const { mcp, clicked } = fakeMcp({ [NAV]: [node(label)] });
      await expect(advanceFomod(mcp)).resolves.toBe(label);
      expect(clicked).toEqual([`ref-${label}`]);
    }
  });

  it("goes forward rather than back when the step offers both", async () => {
    // The nav bar renders Back first and the forward action last.
    const { mcp, clicked } = fakeMcp({
      [NAV]: [node("Select installation options"), node("Installation")],
    });
    await expect(advanceFomod(mcp)).resolves.toBe("Installation");
    expect(clicked).toEqual(["ref-Installation"]);
  });

  it("looks only inside the FOMOD nav bar", async () => {
    // Not a tidiness point. On "Purge files from different instance?" the last
    // button is Purge, and this runs against a real game install — so a
    // page-wide or whole-dialog search would eventually wipe a deployment.
    const { mcp, clicked, selectors } = fakeMcp({
      [NAV]: [node("Next")],
      "": [node("Cancel"), node("Purge")],
    });
    await advanceFomod(mcp);
    expect(selectors).toEqual([NAV]);
    expect(clicked).toEqual(["ref-Next"]);
  });

  it("reports no wizard rather than clicking when none is open", async () => {
    const { mcp, clicked } = fakeMcp({});
    await expect(advanceFomod(mcp)).resolves.toBeUndefined();
    expect(clicked).toEqual([]);
  });

  it("waits rather than walking backwards when the forward button is disabled", async () => {
    // A step mid-render can have Next greyed out. Falling back to the next
    // button along means clicking Back, which walks the wizard backwards and
    // never terminates; doing nothing lets the poll retry.
    const { mcp, clicked } = fakeMcp({
      [NAV]: [node("Back"), node("Next", { disabled: true })],
    });
    await expect(advanceFomod(mcp)).resolves.toBeUndefined();
    expect(clicked).toEqual([]);
  });
});

const PURGE_PROMPT =
  "Purge files from different instance?IMPORTANT: This game was modded by another instance";

function answerTo(text: string, policies = DEFAULT_DIALOG_POLICIES): string | undefined {
  return policies.find((p) => p.match.test(text))?.button.toString();
}

describe("dialogPolicies", () => {
  const purgePrompt = PURGE_PROMPT;

  it("refuses the purge by default", () => {
    // The default runs against whatever game directory is on the machine, which
    // may be someone's real install with another Vortex's files deployed in it.
    expect(answerTo(purgePrompt)).toMatch(/cancel/i);
    expect(answerTo(purgePrompt, dialogPolicies())).toMatch(/cancel/i);
    expect(answerTo(purgePrompt, dialogPolicies({ allowForeignPurge: false }))).toMatch(/cancel/i);
  });

  it("accepts it only when the caller opts in", () => {
    expect(answerTo(purgePrompt, dialogPolicies({ allowForeignPurge: true }))).toMatch(/purge/i);
  });

  it("changes nothing else when opting in", () => {
    // Opting into a purge must not quietly make the other answers destructive.
    const base = DEFAULT_DIALOG_POLICIES;
    const opted = dialogPolicies({ allowForeignPurge: true });
    expect(opted).toHaveLength(base.length);
    for (const [i, policy] of base.entries()) {
      if (policy.match.test(purgePrompt)) continue;
      expect(opted[i]).toBe(policy);
    }
  });

  it("still refuses to abandon an install in progress", () => {
    // This one is first for a reason: Vortex raises it on a stray Escape, and
    // the wrong answer throws away a half-finished install.
    expect(answerTo("Do you want to cancel the installation?")).toMatch(/close/i);
  });
});

/**
 * A client whose snapshots mimic the real shape: `activeDialogs` concatenates
 * text nodes with NO separator, while the tree joins names and text with
 * spaces. Matching one against the other is what silently stalled three
 * separate runs.
 */
function dialogMcp(
  body = "Mod files were changed outside Vortex.",
  options: { withDialogTool?: boolean } = {},
): {
  mcp: VortexMcpClient;
  clicked: string[];
  fullSnapshots: () => number;
} {
  let fullSnapshots = 0;
  const clicked: string[] = [];
  const tree: SnapshotNode[] = [
    { ref: "r1", role: "heading", name: "External Changes" },
    { ref: "r2", role: "text", text: body },
    { ref: "r3", role: "button", name: "Cancel deployment" },
    { ref: "r4", role: "button", name: "Confirm changes" },
  ];
  const mcp = {
    call: (name: string, args: Record<string, unknown> = {}) => {
      if (name === "ui_active_dialogs") {
        if (options.withDialogTool === false) {
          return Promise.reject(new McpError("Tool ui_active_dialogs not found", name));
        }
        return Promise.resolve([`External Changes${body}`]);
      }
      if (name === "ui_snapshot") {
        const scoped = args["selector"] !== undefined;
        if (!scoped) fullSnapshots += 1;
        return Promise.resolve({
          generation: 1,
          title: "Vortex",
          viewport: { width: 1280, height: 800 },
          nodeCount: tree.length,
          truncated: false,
          // No separator, exactly as Vortex reports it.
          activeDialogs: scoped ? [] : [`External Changes${body}`],
          tree,
        } satisfies Snapshot);
      }
      if (name === "ui_click") {
        clicked.push(String(args["ref"]));
        return Promise.resolve(undefined);
      }
      throw new Error(`unexpected tool call: ${name}`);
    },
  } as unknown as VortexMcpClient;
  return { mcp, clicked, fullSnapshots: () => fullSnapshots };
}

describe("autoAnswerDialogs", () => {
  it("answers a dialog whose text is joined differently from the snapshot's", async () => {
    const { mcp, clicked } = dialogMcp();
    const controller = new AbortController();
    const answering = autoAnswerDialogs(mcp, { signal: controller.signal, pollMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const answered = await answering;

    expect(clicked).toContain("r4");
    expect(answered[0]?.clicked).toBe("Confirm changes");
  });

  it("polls for dialogs without full snapshots, which cost seconds on a big mod list", async () => {
    const { mcp, clicked, fullSnapshots } = dialogMcp();
    const controller = new AbortController();
    const answering = autoAnswerDialogs(mcp, { signal: controller.signal, pollMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await answering;
    expect(clicked).toContain("r4");
    expect(fullSnapshots()).toBe(0);
  });

  it("still finds dialogs through a snapshot on an extension without ui_active_dialogs", async () => {
    const { mcp, clicked } = dialogMcp(undefined, { withDialogTool: false });
    const controller = new AbortController();
    const answering = autoAnswerDialogs(mcp, { signal: controller.signal, pollMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await answering;
    expect(clicked).toContain("r4");
  });

  it("never confirms deleted links, whose default deletes the staging files", async () => {
    // Vortex's own wording: every row defaults to "Save change (delete file)".
    const { mcp, clicked } = dialogMcp(
      'Mod files were changed outside Vortex. Links were deleted ("Save" will remove the ' +
        'corresponding source files permanently, "Revert" will recreate the links)' +
        "Revert all changes | Save all changes | example-mod 3 fileSave change (delete file)",
    );
    const refused: string[] = [];
    const controller = new AbortController();
    const answering = autoAnswerDialogs(mcp, {
      signal: controller.signal,
      pollMs: 1,
      onUnanswerable: (_dialog, wanted) => refused.push(wanted),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();

    expect(await answering).toEqual([]);
    expect(clicked).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/staging files/);
  });

  it("still confirms deleted sources, whose default only removes the deployed copies", async () => {
    const { mcp, clicked } = dialogMcp(
      'Mod files were changed outside Vortex. Source files were deleted ("Save" will remove the ' +
        'corresponding files permanently, "Revert" will restore them)Revert all changes | Save all ' +
        "changes | example-mod 1 fileSave change (delete file)",
    );
    const controller = new AbortController();
    const answering = autoAnswerDialogs(mcp, { signal: controller.signal, pollMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await answering;
    expect(clicked).toContain("r4");
  });
});

/**
 * The conflict editor as Vortex renders it: its filter box's placeholder is part of the
 * snapshot tree (as the textbox's name) but not of the dialog's text, which is what
 * `activeDialogs` reports.
 */
const CONFLICT_TEXT =
  "MultipleConflict A 0000Before All | After AllLoadConflict A 0000 (v1.0.0)beforeafter" +
  "never together withConflict B 0000Clear RulesUse SuggestionsHide ResolvedCancelSave";

function conflictEditorMcp(options: { rootText?: boolean; clickReports?: string }): {
  mcp: VortexMcpClient;
  clicked: string[];
} {
  const clicked: string[] = [];
  const tree: SnapshotNode[] = [
    { ref: "c1", role: "tab", name: "Multiple" },
    { ref: "c2", role: "textbox", name: "Search for a rule..." },
    { ref: "c3", role: "text", text: "Conflict A 0000" },
    { ref: "c4", role: "button", name: "Before All" },
    { ref: "c5", role: "button", name: "Cancel" },
    { ref: "c6", role: "button", name: "Save" },
  ];
  const mcp = {
    call: (name: string, args: Record<string, unknown> = {}) => {
      if (name === "ui_snapshot") {
        const index = Number(args["index"] ?? 0);
        if (args["selector"] !== '[role="dialog"]' || index > 0) {
          return Promise.reject(new McpError("No element matches selector", name));
        }
        return Promise.resolve({
          generation: 1,
          title: "Vortex",
          viewport: { width: 1280, height: 800 },
          nodeCount: tree.length,
          truncated: false,
          activeDialogs: [CONFLICT_TEXT],
          ...(options.rootText === false ? {} : { rootText: CONFLICT_TEXT }),
          tree,
        } satisfies Snapshot);
      }
      if (name === "ui_click") {
        clicked.push(String(args["ref"]));
        return Promise.resolve({
          ref: args["ref"],
          role: "button",
          name: options.clickReports ?? "Save",
        });
      }
      throw new Error(`unexpected tool call: ${name}`);
    },
  } as unknown as VortexMcpClient;
  return { mcp, clicked };
}

describe("clickInsideDialog", () => {
  it("finds the conflict editor's Save, which a tree-text prefix never matched", async () => {
    // Regression: the tree read "Multiple Search for a rule... Conflict A 0000", so the
    // dialog's first 20 characters were never adjacent in it and nothing was clicked.
    const { mcp, clicked } = conflictEditorMcp({});
    await expect(clickInsideDialog(mcp, CONFLICT_TEXT, /^save$/i)).resolves.toBe("Save");
    expect(clicked).toEqual(["c6"]);
  });

  it("still matches through the tree on an extension without rootText", async () => {
    const { mcp, clicked } = conflictEditorMcp({ rootText: false });
    await expect(clickInsideDialog(mcp, CONFLICT_TEXT, /^save$/i)).resolves.toBe("Save");
    expect(clicked).toEqual(["c6"]);
  });

  it("throws, listing what it saw, instead of silently clicking nothing", async () => {
    const { mcp, clicked } = conflictEditorMcp({});
    const error = await clickInsideDialog(mcp, CONFLICT_TEXT, /^apply$/i).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DialogClickError);
    expect(String(error)).toMatch(/"Cancel", "Save"/);
    expect(clicked).toEqual([]);
    // A poller can still ask for undefined.
    await expect(
      clickInsideDialog(mcp, CONFLICT_TEXT, /^apply$/i, { required: false }),
    ).resolves.toBeUndefined();
    await expect(
      clickInsideDialog(mcp, "Purge files from different instance?", /^cancel$/i),
    ).rejects.toThrow(/another dialog/);
  });

  it("throws when the element clicked is not the button that was found", async () => {
    const { mcp } = conflictEditorMcp({ clickReports: "Cancel" });
    await expect(clickInsideDialog(mcp, CONFLICT_TEXT, /^save$/i)).rejects.toThrow(
      /Clicked "Cancel"/,
    );
  });
});

describe("snapshotIsDialog", () => {
  const snap = (rootText?: string, tree: SnapshotNode[] = []): Snapshot => ({
    ...snapshotOf(tree),
    ...(rootText === undefined ? {} : { rootText }),
  });

  it("compares the scoped root's text with the dialog's, whitespace and ellipsis aside", () => {
    expect(
      snapshotIsDialog(snap("External  Changes Mod files…"), "External ChangesMod files"),
    ).toBe(true);
    expect(snapshotIsDialog(snap("Game version mismatch"), "External Changes")).toBe(false);
    expect(snapshotIsDialog(snap(""), "External Changes")).toBe(false);
    expect(snapshotIsDialog(snap("anything"), "")).toBe(false);
  });

  it("without rootText, needs the dialog's text in the tree in order", () => {
    const tree = [node("External Changes"), node("Confirm changes")];
    expect(snapshotIsDialog(snap(undefined, tree), "External ChangesConfirm")).toBe(true);
    expect(snapshotIsDialog(snap(undefined, tree), "Confirm changesExternal")).toBe(false);
  });
});
