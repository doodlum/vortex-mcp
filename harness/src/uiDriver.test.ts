import { describe, expect, it } from "vitest";

import type { VortexMcpClient } from "./mcpClient";
import { advanceFomod, type Snapshot, type SnapshotNode } from "./uiDriver";

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
