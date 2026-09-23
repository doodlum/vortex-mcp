import { AsyncLocalStorage } from "node:async_hooks";
import type { VortexMcpClient } from "./mcpClient";

const owners = new AsyncLocalStorage<VortexMcpClient>();
const queues = new WeakMap<VortexMcpClient, Promise<unknown>>();

/** Keep background dialog snapshots from invalidating a foreground action's refs. */
export async function withUiLock<T>(mcp: VortexMcpClient, action: () => Promise<T>): Promise<T> {
  if (owners.getStore() === mcp) return action();
  const previous = queues.get(mcp) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => owners.run(mcp, action));
  queues.set(
    mcp,
    result.catch(() => undefined),
  );
  return result;
}
