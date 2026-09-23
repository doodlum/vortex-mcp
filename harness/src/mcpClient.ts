/**
 * A minimal MCP client for the vortex-mcp server running inside Vortex.
 *
 * Hand-rolled rather than pulled from the MCP SDK on purpose: vortex-mcp's
 * transport is *stateless* Streamable HTTP (2026-07-28 spec — no `initialize`
 * handshake, no session id), so a conforming call is a single JSON-RPC POST.
 * The SDK would add a dependency and a connection lifecycle to manage for
 * something that is genuinely one fetch.
 */
import { setTimeout as delay } from "node:timers/promises";

export interface McpToolResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpToolResultContent[];
  isError?: boolean;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly toolName: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpClientOptions {
  port: number;
  token: string;
  /** Per-request budget. Some tools (deploy, install) legitimately run for minutes. */
  timeoutMs?: number;
}

export class VortexMcpClient {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  #nextId = 1;

  constructor(options: McpClientOptions) {
    this.#url = `http://127.0.0.1:${String(options.port)}/mcp`;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  get url(): string {
    return this.#url;
  }

  async #rpc(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.#nextId++, method, params });
    const response = await fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The server speaks both; ask for both so it can stream if it wants to.
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.#token}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs ?? this.#timeoutMs),
    });

    if (response.status === 403) {
      throw new Error(
        "vortex-mcp rejected the token (403). The VORTEX_MCP_TOKEN the harness is using does not " +
          "match the one Vortex was launched with — relaunch through `vortex-ai up` so both come " +
          "from the same config.",
      );
    }
    if (!response.ok) {
      throw new Error(`MCP request failed: ${String(response.status)} ${response.statusText}`);
    }

    const raw = await response.text();
    return parseRpcPayload(raw);
  }

  /** List the tools the server currently exposes — write tools only appear with a token. */
  async listTools(): Promise<{ name: string; description: string; inputSchema?: unknown }[]> {
    const result = (await this.#rpc("tools/list", {})) as {
      tools?: { name: string; description?: string; inputSchema?: unknown }[];
    };
    return (result.tools ?? []).map((t) => ({ ...t, description: t.description ?? "" }));
  }

  /** Call a tool and return its raw content blocks. */
  async callRaw(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<McpToolResult> {
    const result = (await this.#rpc(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    )) as McpToolResult;

    if (result.isError === true) {
      const text = result.content.map((c) => c.text ?? "").join("\n");
      throw new McpError(text === "" ? `Tool ${name} failed` : text, name);
    }
    return result;
  }

  /**
   * Call a tool and parse its first text block as JSON.
   *
   * Every vortex-mcp tool that returns structured data serialises it through one
   * `jsonText` helper, so this is the normal path. Tools that return a plain
   * status sentence (`switch_profile`, `backup_state`) are handled by returning
   * the string itself rather than throwing on a JSON parse failure.
   */
  async call<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const result = await this.callRaw(name, args, timeoutMs);
    const text = result.content.find((c) => c.type === "text")?.text;
    if (text === undefined) {
      return result as unknown as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** Call a tool expected to return an image, and hand back the raw base64 PNG. */
  async callImage(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.callRaw(name, args);
    const image = result.content.find((c) => c.type === "image");
    if (image?.data === undefined) {
      const text = result.content.map((c) => c.text ?? "").join("\n");
      throw new McpError(`${name} returned no image. ${text}`, name);
    }
    return image.data;
  }

  /** True once the server answers — used to know the renderer has finished booting. */
  async ping(): Promise<boolean> {
    try {
      await this.#rpc("tools/list", {}, 3_000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Block until the MCP server inside Vortex answers.
   *
   * This is the harness's definition of "Vortex is ready": the extension only
   * registers in `context.once`, which runs after the renderer has loaded its
   * extensions and the Redux store is live. Polling a port would be satisfied
   * far too early, while the app is still on the splash screen.
   */
  async waitUntilReady(timeoutMs = 180_000, pollMs = 500, signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    let lastError = "never answered";
    for (;;) {
      signal?.throwIfAborted();
      if (await this.ping()) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `vortex-mcp did not become ready within ${String(Math.round(timeoutMs / 1000))}s ` +
            `(${this.#url}; last state: ${lastError}). Check that the extension is installed into ` +
            `the instance's plugins/ directory and that Vortex actually started.`,
        );
      }
      lastError = "not answering yet";
      await delay(pollMs, undefined, { signal });
    }
  }
}

/**
 * Streamable HTTP may answer as plain JSON or as an SSE stream, depending on
 * what the server decides per request. Handle both rather than assuming, since
 * the choice is not ours to make and a wrong assumption fails intermittently.
 */
function parseRpcPayload(raw: string): unknown {
  const text = raw.trim();
  const json = text.startsWith("{") ? text : extractSseData(text);

  const parsed = JSON.parse(json) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
  if (parsed.error !== undefined) {
    throw new Error(`MCP error ${String(parsed.error.code)}: ${parsed.error.message}`);
  }
  return parsed.result;
}

function extractSseData(text: string): string {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    throw new Error(`Unrecognised MCP response body: ${text.slice(0, 200)}`);
  }
  return dataLines.join("");
}
