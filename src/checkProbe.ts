/**
 * Observe whether Vortex runs its health checks, without changing Vortex.
 *
 * Vortex runs registered checks ("tests") when named events fire — `plugins-changed`,
 * `mod-installed`, `gamemode-activated`, … — unless that event is suppressed, which
 * happens silently and leaves nothing in the log. A check that never runs is how a
 * warning such as Missing Masters fails to appear: nothing errors, the user is simply
 * never told.
 *
 * So this registers a probe check per event through Vortex's own public
 * `registerTest`, the same API every extension's checks use. The probe finds nothing
 * (its notification is only ever dismissed) and counts each time Vortex runs it. A
 * count that stops rising while its event keeps firing means the event is suppressed.
 */

export const PROBED_EVENTS = [
  "plugins-changed",
  "mod-installed",
  "mod-activated",
  "settings-changed",
  "gamemode-activated",
  "profile-did-change",
] as const;

export interface ProbeCount {
  event: string;
  runs: number;
  /** ISO time of the last run, or null. */
  lastRun: string | null;
}

const counts = new Map<string, ProbeCount>(
  PROBED_EVENTS.map((event) => [event, { event, runs: 0, lastRun: null }]),
);

/** The check registered for `event`. Exported for tests. */
export function probeFor(event: string): () => Promise<undefined> {
  return () => {
    const count = counts.get(event) ?? { event, runs: 0, lastRun: null };
    count.runs += 1;
    count.lastRun = new Date().toISOString();
    counts.set(event, count);
    return Promise.resolve(undefined);
  };
}

type RegisterTest = (id: string, eventType: string, check: () => PromiseLike<unknown>) => void;

/**
 * Register the probes. Must run during extension init, where `registerTest` is valid;
 * ids are namespaced so they cannot collide with a real check's notification.
 */
export function registerCheckProbes(registerTest: RegisterTest | undefined): void {
  if (registerTest === undefined) return;
  for (const event of PROBED_EVENTS) {
    registerTest(`vortex-mcp-probe-${event}`, event, probeFor(event));
  }
}

export function probeCounts(): ProbeCount[] {
  return [...counts.values()].map((c) => ({ ...c }));
}
