/**
 * Performance tracing from inside the renderer, without changing Vortex.
 *
 * Slowdowns that only large mod lists reproduce ("deploy takes 12 minutes", "the UI
 * freezes while a collection installs") need two answers before anyone can fix them:
 * what the renderer spent its time on, and which state changes drove it. Vortex has
 * no switch for either, and patching it would defeat the point of testing a stock
 * build. An extension, though, holds the same store every other extension dispatches
 * through, and runs in the renderer where the browser's own timing APIs live:
 *
 * - `store.dispatch` is wrapped once. While a trace runs, every dispatch is timed and
 *   counted by action type. A Redux dispatch runs the middleware (including Vortex's
 *   persistence diffing), the reducers and the subscribers synchronously, so its time
 *   is what one state change cost on the main thread before React rendered anything.
 * - A `longtask` PerformanceObserver records every main-thread task over 50ms. React's
 *   rendering is batched and runs after the dispatch returns, so this is where render
 *   cost shows up.
 * - The JS heap is sampled, because the large-library reports end in out-of-memory
 *   renderer crashes as often as in freezes.
 *
 * Outside a trace the wrapper is one boolean check per dispatch.
 */

export interface ActionStat {
  type: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface TraceSummary {
  durationMs: number;
  dispatches: { count: number; totalMs: number };
  /** Action types by the time their dispatches took, most expensive first. */
  byTime: ActionStat[];
  /** Action types by how often they were dispatched. */
  byCount: ActionStat[];
  longTasks: { count: number; totalMs: number; maxMs: number };
  heapMb: { start: number; max: number; end: number } | null;
}

interface TraceState {
  active: boolean;
  startedAt: number;
  actions: Map<string, ActionStat>;
  longTasks: number[];
  heap: number[];
  heapTimer: ReturnType<typeof setInterval> | undefined;
  observer: PerformanceObserver | undefined;
}

const trace: TraceState = {
  active: false,
  startedAt: 0,
  actions: new Map(),
  longTasks: [],
  heap: [],
  heapTimer: undefined,
  observer: undefined,
};

const WRAPPED = Symbol.for("vortex-mcp.perfTrace.wrapped");

interface Dispatching {
  dispatch: (action: unknown) => unknown;
  [WRAPPED]?: true;
}

/** Name an action for grouping: its `type`, or what kind of non-plain action it is. */
export function actionType(action: unknown): string {
  if (typeof action === "function") return "(thunk)";
  if (action !== null && typeof action === "object" && "type" in action) {
    return String((action as { type: unknown }).type);
  }
  return "(unknown)";
}

/** Record one timed dispatch. Exported for tests; the wrapper is the only caller. */
export function recordDispatch(type: string, ms: number): void {
  const stat = trace.actions.get(type) ?? { type, count: 0, totalMs: 0, maxMs: 0 };
  stat.count += 1;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  trace.actions.set(type, stat);
}

/**
 * Wrap `store.dispatch` so traces can time it. Idempotent: an extension reload finds
 * the store already wrapped and leaves it alone rather than stacking a second timer.
 */
export function installDispatchTracer(store: Dispatching): void {
  if (store[WRAPPED] === true) return;
  const original = store.dispatch.bind(store);
  store.dispatch = (action: unknown) => {
    if (!trace.active) return original(action);
    const start = performance.now();
    try {
      return original(action);
    } finally {
      recordDispatch(actionType(action), performance.now() - start);
    }
  };
  store[WRAPPED] = true;
}

function heapMb(): number | undefined {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory === undefined ? undefined : memory.usedJSHeapSize / (1024 * 1024);
}

function sampleHeap(): void {
  const mb = heapMb();
  if (mb !== undefined) trace.heap.push(mb);
}

/** Start a trace, discarding anything recorded by a previous one. */
export function startTrace(options: { heapSampleMs?: number } = {}): { startedAt: number } {
  stopCollectors();
  trace.actions = new Map();
  trace.longTasks = [];
  trace.heap = [];
  trace.startedAt = performance.now();
  trace.active = true;
  sampleHeap();
  trace.heapTimer = setInterval(sampleHeap, options.heapSampleMs ?? 1_000);
  if (typeof PerformanceObserver !== "undefined") {
    try {
      trace.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) trace.longTasks.push(entry.duration);
      });
      trace.observer.observe({ type: "longtask" });
    } catch {
      // No longtask support in this runtime; dispatch timing still works.
      trace.observer = undefined;
    }
  }
  return { startedAt: trace.startedAt };
}

function stopCollectors(): void {
  if (trace.heapTimer !== undefined) clearInterval(trace.heapTimer);
  trace.heapTimer = undefined;
  trace.observer?.disconnect();
  trace.observer = undefined;
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

/** Summarise what was recorded. Pure, so it can be tested without a renderer. */
export function summarise(
  actions: Iterable<ActionStat>,
  longTasks: number[],
  heap: number[],
  durationMs: number,
  top = 15,
): TraceSummary {
  const stats = [...actions].map((s) => ({
    ...s,
    totalMs: round(s.totalMs),
    maxMs: round(s.maxMs),
  }));
  return {
    durationMs: Math.round(durationMs),
    dispatches: {
      count: stats.reduce((sum, s) => sum + s.count, 0),
      totalMs: round(stats.reduce((sum, s) => sum + s.totalMs, 0)),
    },
    byTime: [...stats].sort((a, b) => b.totalMs - a.totalMs).slice(0, top),
    byCount: [...stats].sort((a, b) => b.count - a.count).slice(0, top),
    longTasks: {
      count: longTasks.length,
      totalMs: round(longTasks.reduce((sum, t) => sum + t, 0)),
      maxMs: round(Math.max(0, ...longTasks)),
    },
    heapMb:
      heap.length === 0
        ? null
        : {
            start: Math.round(heap[0] ?? 0),
            max: Math.round(Math.max(...heap)),
            end: Math.round(heap[heap.length - 1] ?? 0),
          },
  };
}

/** Stop the trace and return its summary. Stopping without a trace returns an empty one. */
export function stopTrace(options: { top?: number } = {}): TraceSummary {
  if (!trace.active) return summarise([], [], [], 0, options.top);
  const durationMs = performance.now() - trace.startedAt;
  sampleHeap();
  trace.active = false;
  stopCollectors();
  return summarise(trace.actions.values(), trace.longTasks, trace.heap, durationMs, options.top);
}

/** Whether a trace is running, and for how long. */
export function traceStatus(): { active: boolean; elapsedMs: number } {
  return {
    active: trace.active,
    elapsedMs: trace.active ? Math.round(performance.now() - trace.startedAt) : 0,
  };
}
