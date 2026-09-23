import { describe, expect, it } from "vitest";

import type { VortexMcpClient } from "./mcpClient";
import {
  advanceFomod,
  autoAnswerDialogs,
  DEFAULT_DIALOG_POLICIES,
  dialogPolicies,
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

describe("autoAnswerDialogs", () => {
  /**
   * A client whose snapshots mimic the real shape: `activeDialogs` concatenates
   * text nodes with NO separator, while the tree joins names and text with
   * spaces. Matching one against the other is what silently stalled three
   * separate runs.
   */
  function fakeMcp(): { mcp: VortexMcpClient; clicked: string[] } {
    const clicked: string[] = [];
    const tree: SnapshotNode[] = [
      { ref: "r1", role: "heading", name: "External Changes" },
      { ref: "r2", role: "text", text: "Mod files were changed outside Vortex." },
      { ref: "r3", role: "button", name: "Cancel deployment" },
      { ref: "r4", role: "button", name: "Confirm changes" },
    ];
    const mcp = {
      call: (name: string, args: Record<string, unknown> = {}) => {
        if (name === "ui_snapshot") {
          const scoped = args["selector"] !== undefined;
          return Promise.resolve({
            generation: 1,
            title: "Vortex",
            viewport: { width: 1280, height: 800 },
            nodeCount: tree.length,
            truncated: false,
            // No separator, exactly as Vortex reports it.
            activeDialogs: scoped ? [] : ["External ChangesMod files were changed outside Vortex."],
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
    return { mcp, clicked };
  }

  it("answers a dialog whose text is joined differently from the snapshot's", async () => {
    const { mcp, clicked } = fakeMcp();
    const controller = new AbortController();
    const answering = autoAnswerDialogs(mcp, { signal: controller.signal, pollMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const answered = await answering;

    expect(clicked).toContain("r4");
    expect(answered[0]?.clicked).toBe("Confirm changes");
  });
});
