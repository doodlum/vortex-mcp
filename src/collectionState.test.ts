// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyDialog,
  describeDriver,
  dialogCollection,
  installedCollections,
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
      preparing: null,
      starting: null,
      lastCollectionId: undefined,
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
    // As the DOM's text runs: the buttons' labels without a space between them.
    expect(classifyDialog("Install this collection to profile: Default LaterInstall Now")).toBe(
      "query",
    );
    // Cut at 400 characters before its buttons.
    expect(classifyDialog("Fallout 4 collection addedRevision 3Big Pack By someone")).toBe("query");
    expect(classifyDialog("External Changes")).toBeUndefined();
  });
});

describe("what the driver is doing between steps", () => {
  it("reports a prepare() chain still pending and a start attempt in progress", () => {
    const driver = new FakeDriver("start") as FakeDriver & Record<string, unknown>;
    // Not observable: no Bluebird chain, and a build without the mStarting token.
    expect(describeDriver(driver)).toMatchObject({ preparing: null, starting: null });
    driver.mPrepare = { isPending: () => true };
    driver.mStarting = {};
    expect(describeDriver(driver)).toMatchObject({ preparing: true, starting: true });
    driver.mPrepare = { isPending: () => false };
    driver.mStarting = undefined;
    expect(describeDriver(driver)).toMatchObject({ preparing: false, starting: false });
  });
});

const withFiber = (fiber: FiberLike): HTMLElement => {
  const element = document.createElement("div");
  Object.assign(element, { __reactFiber$abc: fiber });
  return element;
};

describe("which collection a dialog belongs to", () => {
  it("reads the rendering component's driver, falling back to its last collection", () => {
    const driver = new FakeDriver("review");
    const component: FiberLike = { memoizedProps: { driver } };
    const modal = withFiber({ memoizedProps: { className: "modal" }, return: component });
    expect(dialogCollection(modal)).toEqual({
      collectionId: "coll-1",
      collectionName: "My collection",
      via: "driver",
    });
    const ended = Object.assign(new FakeDriver("review"), {
      lastCollection: { id: "coll-2", attributes: { name: "Earlier" } },
    });
    Object.defineProperty(ended, "collection", { get: () => undefined });
    expect(
      dialogCollection(withFiber({ memoizedProps: { driver: ended }, return: null })),
    ).toMatchObject({ collectionId: "coll-2", via: "driver" });
  });

  it("reads a collection prop, then the dialog's text, and otherwise says it cannot tell", () => {
    const collection = { id: "c9", type: "collection", attributes: { name: "Nine" } };
    const byProp = withFiber({ memoizedProps: {}, return: { memoizedProps: { collection } } });
    expect(dialogCollection(byProp)).toEqual({
      collectionId: "c9",
      collectionName: "Nine",
      via: "collection-prop",
    });
    const known = installedCollections({
      fallout4: {
        a: { type: "collection", attributes: { name: "Big" } },
        b: { type: "collection", attributes: { name: "b.zip", customFileName: "Big Pack" } },
        m: { type: "", attributes: { name: "A mod" } },
      },
    });
    expect(known).toEqual([
      { id: "a", name: "Big" },
      { id: "b", name: "Big Pack" },
    ]);
    const prompt = document.createElement("div");
    expect(dialogCollection(prompt, known, "Game version mismatch Big Pack needs 1.2")).toEqual({
      collectionId: "b",
      collectionName: "Big Pack",
      via: "text",
    });
    expect(dialogCollection(prompt, known, "External Changes")).toEqual({
      collectionId: null,
      collectionName: null,
      via: null,
    });
  });
});
