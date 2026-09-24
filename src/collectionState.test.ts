// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyDialog,
  describeDriver,
  fiberOf,
  findDriver,
  readDriver,
  resetDriverCache,
  rootOf,
  summariseSession,
  type FiberLike,
} from "./collectionState";

/** A stand-in with InstallDriver's getters, as the dialogs receive it. */
class FakeDriver {
  constructor(private mStep = "query") {}
  get step() {
    return this.mStep;
  }
  set step(value: string) {
    this.mStep = value;
  }
  get installDone() {
    return false;
  }
  get postprocessing() {
    return false;
  }
  get collection() {
    return { id: "coll-1", attributes: { name: "My collection" } };
  }
  get revisionId(): number {
    throw new Error("no download yet");
  }
  onUpdate() {
    return () => undefined;
  }
  continue() {
    return Promise.resolve();
  }
}

/** root → app → [page, dialogs → [other, finish(driver)]] */
function tree(driver: unknown): { root: FiberLike; leaf: FiberLike } {
  const root: FiberLike = { tag: 3 };
  const app: FiberLike = { return: root, memoizedProps: { children: [] } };
  const page: FiberLike = { return: app, memoizedProps: { driver: { step: "not a driver" } } };
  const dialogs: FiberLike = { return: app, memoizedProps: {} };
  const other: FiberLike = { return: dialogs, memoizedProps: null };
  const finish: FiberLike = { return: dialogs, memoizedProps: { driver, visible: false } };
  root.child = app;
  app.child = page;
  page.sibling = dialogs;
  dialogs.child = other;
  other.sibling = finish;
  return { root, leaf: other };
}

afterEach(() => {
  resetDriverCache();
  document.body.innerHTML = "";
});

describe("finding the collection InstallDriver", () => {
  it("walks from any fiber to the root and finds the driver prop, not look-alikes", () => {
    const driver = new FakeDriver();
    const { root, leaf } = tree(driver);
    expect(rootOf(leaf)).toBe(root);
    expect(findDriver(root).driver).toBe(driver);
    expect(findDriver(tree(undefined).root).driver).toBeUndefined();
  });

  it("reads the getters, surviving one that throws", () => {
    expect(describeDriver(new FakeDriver("review"))).toEqual({
      found: true,
      step: "review",
      installDone: false,
      postprocessing: false,
      collectionId: "coll-1",
      collectionName: "My collection",
      installingMod: undefined,
      numRequired: undefined,
      revisionId: undefined,
    });
  });

  it("starts from the element React attached a fiber to, and follows the live step", () => {
    const driver = new FakeDriver();
    const { leaf } = tree(driver);
    const content = document.createElement("div");
    content.id = "content";
    const child = document.createElement("div");
    (child as unknown as Record<string, unknown>).__reactFiber$abc = leaf;
    content.appendChild(child);
    document.body.appendChild(content);

    expect(fiberOf(child)).toBe(leaf);
    expect(readDriver(document)).toMatchObject({ found: true, step: "query" });
    driver.step = "installing";
    expect(readDriver(document).step).toBe("installing");
  });

  it("says why when the app has no fiber or no driver", () => {
    expect(readDriver(document)).toMatchObject({
      found: false,
      reason: expect.stringMatching(/no React fiber/),
    });
    const content = document.createElement("div");
    content.id = "content";
    (content as unknown as Record<string, unknown>)._reactRootContainer = {
      _internalRoot: { current: tree(undefined).root },
    };
    document.body.appendChild(content);
    expect(readDriver(document)).toMatchObject({
      found: false,
      reason: expect.stringMatching(/no component has a driver prop/),
    });
  });
});

describe("the install session and dialogs", () => {
  it("counts members by status and type and lists what is outstanding", () => {
    const summary = summariseSession({
      sessionId: "s1",
      collectionId: "coll-1",
      gameId: "fallout4",
      totalRequired: 2,
      nested: { ignored: true },
      mods: {
        a: { status: "installed", type: "requires" },
        b: { status: "installing", type: "requires" },
        c: { status: "ignored", type: "recommends" },
      },
    });
    expect(summary).toEqual({
      sessionId: "s1",
      collectionId: "coll-1",
      gameId: "fallout4",
      statusCounts: { installed: 1, installing: 1, ignored: 1 },
      typeCounts: { requires: 2, recommends: 1 },
      outstanding: [{ id: "b", status: "installing", type: "requires" }],
      fields: { sessionId: "s1", collectionId: "coll-1", gameId: "fallout4", totalRequired: 2 },
    });
    expect(summariseSession(undefined)).toBeNull();
  });

  it("tags the collection dialogs with their step", () => {
    expect(classifyDialog("Collection installation complete ... Done")).toBe("review");
    expect(classifyDialog("Game version mismatch  Cancel Continue")).toBe("game-version-prompt");
    expect(classifyDialog("My collection ... Install Now")).toBe("query");
    expect(classifyDialog("External Changes")).toBeUndefined();
  });
});
