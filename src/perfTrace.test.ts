import { afterEach, describe, expect, it } from "vitest";

import {
  actionType,
  installDispatchTracer,
  startTrace,
  stopTrace,
  summarise,
  traceStatus,
} from "./perfTrace";

afterEach(() => {
  stopTrace();
});

function fakeStore() {
  const seen: unknown[] = [];
  return {
    seen,
    store: {
      dispatch: (action: unknown) => {
        seen.push(action);
        return action;
      },
    },
  };
}

describe("actionType", () => {
  it("names plain actions by type and the rest by kind", () => {
    expect(actionType({ type: "ADD_MODS" })).toBe("ADD_MODS");
    expect(actionType(() => undefined)).toBe("(thunk)");
    expect(actionType(null)).toBe("(unknown)");
  });
});

describe("installDispatchTracer", () => {
  it("passes every action through and returns what dispatch returned", () => {
    const { store, seen } = fakeStore();
    installDispatchTracer(store);
    const action = { type: "A" };
    expect(store.dispatch(action)).toBe(action);
    startTrace();
    expect(store.dispatch(action)).toBe(action);
    expect(seen).toEqual([action, action]);
  });

  it("counts only while a trace is running", () => {
    const { store } = fakeStore();
    installDispatchTracer(store);
    store.dispatch({ type: "BEFORE" });
    startTrace();
    store.dispatch({ type: "DURING" });
    store.dispatch({ type: "DURING" });
    const summary = stopTrace();
    store.dispatch({ type: "AFTER" });

    expect(summary.dispatches.count).toBe(2);
    expect(summary.byCount.map((s) => s.type)).toEqual(["DURING"]);
    expect(stopTrace().dispatches.count).toBe(0);
  });

  it("wraps a store once, however often it is installed", () => {
    const { store } = fakeStore();
    installDispatchTracer(store);
    const wrapped = store.dispatch;
    installDispatchTracer(store);
    expect(store.dispatch).toBe(wrapped);
    startTrace();
    store.dispatch({ type: "ONCE" });
    expect(stopTrace().dispatches.count).toBe(1);
  });

  it("still records a dispatch whose reducer throws", () => {
    const store = {
      dispatch: (): never => {
        throw new Error("reducer failed");
      },
    };
    installDispatchTracer(store);
    startTrace();
    expect(() => store.dispatch()).toThrow("reducer failed");
    expect(stopTrace().byCount[0]?.type).toBe("(unknown)");
  });
});

describe("summarise", () => {
  it("ranks by time and by count, and reduces tasks and heap", () => {
    const summary = summarise(
      [
        { type: "CHEAP_OFTEN", count: 100, totalMs: 10, maxMs: 1 },
        { type: "RARE_COSTLY", count: 2, totalMs: 900, maxMs: 600 },
      ],
      [60, 200, 90],
      [100, 350, 300],
      5_000,
    );
    expect(summary.byTime[0]?.type).toBe("RARE_COSTLY");
    expect(summary.byCount[0]?.type).toBe("CHEAP_OFTEN");
    expect(summary.dispatches).toEqual({ count: 102, totalMs: 910 });
    expect(summary.longTasks).toEqual({ count: 3, totalMs: 350, maxMs: 200 });
    expect(summary.heapMb).toEqual({ start: 100, max: 350, end: 300 });
  });

  it("reports no heap when the runtime exposes none", () => {
    expect(summarise([], [], [], 0).heapMb).toBeNull();
  });
});

describe("traceStatus", () => {
  it("follows start and stop", () => {
    expect(traceStatus().active).toBe(false);
    startTrace();
    expect(traceStatus().active).toBe(true);
    stopTrace();
    expect(traceStatus().active).toBe(false);
  });
});
