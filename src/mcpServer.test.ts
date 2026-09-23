import http from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  log: vi.fn(),
}));

vi.mock("./vortexControl", () => ({
  describeApi: vi.fn(() => ({
    selectors: [],
    actions: [],
    dispatchableActions: [],
    dispatchHints: {},
    stateKeys: [],
    extensionApis: [],
  })),
  querySelector: vi.fn(() => undefined),
  scanExtensionActions: vi.fn(async () => []),
  queryStatePath: vi.fn(() => undefined),
  switchProfile: vi.fn(),
  cloneProfile: vi.fn(async () => ({
    id: "new-id",
    name: "clone",
    gameId: "skyrimse",
    active: false,
  })),
  listMods: vi.fn(() => []),
  listLoadOrder: vi.fn(() => []),
  getPluginDetails: vi.fn(async () => []),
  listCategories: vi.fn(() => []),
  listDownloads: vi.fn(() => []),
  listNotifications: vi.fn(() => []),
  listModRules: vi.fn(() => []),
  listDialogs: vi.fn(() => []),
  listExternalChanges: vi.fn(() => []),
  findModByFile: vi.fn(async () => []),
  findMissingMasters: vi.fn(async () => []),
  listRuntimeErrors: vi.fn(async () => []),
  listDuplicateMods: vi.fn(async () => []),
  findStaleMods: vi.fn(() => []),
  findStaleDownloads: vi.fn(() => []),
  listKnownModConflicts: vi.fn(() => []),
  listUnsolvedConflicts: vi.fn(() => []),
  findMissingDeployedFiles: vi.fn(async () => []),
  findOrphanedFiles: vi.fn(async () => []),
  checkNexusModUpdates: vi.fn(async () => ({
    checkedCount: 0,
    updatedModIds: [],
    eligibleCount: 0,
  })),
  listFileConflicts: vi.fn(async () => []),
  setModsEnabled: vi.fn(async () => undefined),
  launchGame: vi.fn(async () => undefined),
  restartVortex: vi.fn(),
  dispatchAction: vi.fn(async () => ({ type: "NOOP" })),
  pollListener: vi.fn(() => ({ entries: [], lastSeq: 0 })),
  backupState: vi.fn(async () => "C:\\fake\\backup.json"),
}));

import * as control from "./vortexControl";

let startMcpServer: typeof import("./mcpServer").startMcpServer;
let port: number;
let server: http.Server;

// Mutable so redaction tests can put a fake credential in place and confirm it never
// reaches a response — real shape is settings.confidential.account.nexus.{APIKey,
// OAuthCredentials}, but only the value/structure matters to the redaction logic.
const fakeState: { confidential: Record<string, unknown> } = { confidential: {} };

function request(
  options: Partial<http.RequestOptions> & { body?: unknown; bodyReady?: Promise<void> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { body, bodyReady, ...rest } = options;
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", ...rest },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(3_000, () => req.destroy(new Error("HTTP response timed out")));
    if (bodyReady) {
      req.flushHeaders();
      void bodyReady.then(() => req.end(JSON.stringify(body)));
    } else {
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    }
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  },
};

const jsonHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function parseToolNames(body: string): string[] {
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as {
    result?: { tools?: Array<{ name: string }> };
  };
  return (parsed.result?.tools ?? []).map((tool) => tool.name);
}

describe("mcpServer HTTP gating", () => {
  beforeAll(async () => {
    process.env.VORTEX_MCP_PORT = "38173";
    port = 38173;
    ({ startMcpServer } = await import("./mcpServer"));
    server = startMcpServer({ getState: () => fakeState } as never);
    await new Promise<void>((resolve) => server.once("listening", resolve));
  });

  afterAll(() => {
    server.close();
  });

  it("returns 404 for any path other than /mcp", async () => {
    const res = await request({ path: "/nope", headers: jsonHeaders });
    expect(res.status).toBe(404);
  });

  it("rejects a request whose Host header isn't localhost/127.0.0.1 (DNS-rebinding guard)", async () => {
    const res = await request({
      headers: { ...jsonHeaders, host: "evil.example" },
      body: initializeBody,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a request with a spoofed Origin header", async () => {
    const res = await request({
      headers: { ...jsonHeaders, origin: "http://evil.example" },
      body: initializeBody,
    });
    expect(res.status).toBe(403);
  });

  it("accepts a well-formed initialize request from localhost", async () => {
    const res = await request({ headers: jsonHeaders, body: initializeBody });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"protocolVersion"');
  });

  it("keeps simultaneous clients with the same request id independent", async () => {
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(control.scanExtensionActions).mockImplementationOnce(async () => {
      began();
      await gate;
      return [];
    });
    const slow = request({
      headers: jsonHeaders,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scan_extension_actions", arguments: {} },
      },
    });
    await started;
    const quick = await request({
      headers: jsonHeaders,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
    });
    finish();
    expect(quick.status).toBe(200);
    expect((await slow).status).toBe(200);
  });

  it("routes a delayed request body to its own response after another client finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => server.once("request", () => resolve()));
    const delayed = request({
      headers: jsonHeaders,
      bodyReady: gate,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    await arrived;
    try {
      const quick = await request({ headers: jsonHeaders, body: initializeBody });
      expect(quick.status).toBe(200);
    } finally {
      release();
    }
    const response = await delayed;
    expect(response.status).toBe(200);
    expect(parseToolNames(response.body)).toContain("vortex_query");
  });

  it("only registers read tools when VORTEX_MCP_TOKEN is unset (fail closed)", async () => {
    const res = await request({
      headers: jsonHeaders,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(res.status).toBe(200);
    const names = parseToolNames(res.body);
    expect(names).toEqual(
      expect.arrayContaining([
        "vortex_query",
        "vortex_describe",
        "scan_extension_actions",
        "list_mods",
        "list_load_order",
        "get_plugin_details",
        "list_categories",
        "list_downloads",
        "find_stale_downloads",
        "list_notifications",
        "list_mod_rules",
        "list_dialogs",
        "list_external_changes",
        "find_mod_by_file",
        "list_file_conflicts",
        "find_missing_masters",
        "list_runtime_errors",
        "list_duplicate_mods",
        "find_stale_mods",
        "list_known_mod_conflicts",
        "list_unsolved_conflicts",
        "find_missing_deployed_files",
        "find_orphaned_files",
        "check_nexus_mod_updates",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "purge_mods",
        "install_mod_from_url",
        "switch_profile",
        "clone_profile",
        "vortex_dispatch",
        "poll_listener",
        "backup_state",
        "vortex_restart",
      ]),
    );
  });

  it("returns a clean null (not a transport error) when a vortex_query path resolves to undefined", async () => {
    // querySelector/queryStatePath are mocked to return undefined above (an unresolved
    // selector/path is a legitimate result, found live) — JSON.stringify(undefined) used
    // to return the actual `undefined` value instead of a string, which failed the MCP
    // SDK's own response-schema validation (content[].text must be string) and surfaced
    // as a JSON-RPC error instead of a normal tool result. Regression test for that.
    const res = await request({
      headers: jsonHeaders,
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "vortex_query", arguments: { path: ["nonexistent", "path"] } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('"error"');
    const dataLine = res.body.split("\n").find((line) => line.startsWith("data: "));
    const parsed = JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as {
      result?: { content?: Array<{ type: string; text: string }> };
    };
    expect(parsed.result?.content?.[0]?.text).toBe("null");
  });

  it("vortex_query throws a clear error when neither selector nor path is given", async () => {
    const res = await request({
      headers: jsonHeaders,
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "vortex_query", arguments: {} },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Provide either");
  });

  it("list_mod_rules rejects an empty modId with a clear message instead of 'Unknown mod: '", async () => {
    // Found live: modId as a plain z.string() let an empty string through schema
    // validation, reaching control.listModRules and producing "Unknown mod: " with
    // nothing after the colon — technically correct but reads like "not found" rather
    // than "modId is required".
    const res = await request({
      headers: jsonHeaders,
      body: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "list_mod_rules", arguments: { modId: "" } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("modId is required");
    expect(res.body).not.toContain("Unknown mod");
  });

  // Redacted at the jsonText funnel in mcpServer.ts, by provenance from state.confidential
  // — not by name-gating the `apiKey` selector or blocking a `confidential`-prefixed path
  // (see vortexControl's own selector/path reflection, which stays name-agnostic).
  describe("confidential redaction", () => {
    afterEach(() => {
      fakeState.confidential = {};
    });

    it("redacts a freshly-computed string a selector returns (selector mode)", async () => {
      const fakeApiKey = "abcdefghijklmnopqrstuvwxyz123456";
      fakeState.confidential = { account: { nexus: { APIKey: fakeApiKey } } };
      vi.mocked(control.querySelector).mockReturnValueOnce(fakeApiKey);

      const res = await request({
        headers: jsonHeaders,
        body: {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "vortex_query", arguments: { selector: "apiKey" } },
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(fakeApiKey);
      expect(res.body).toContain("[redacted: state.confidential]");
    });

    it("redacts the confidential subtree structurally in path mode, e.g. path: []", async () => {
      const fakeToken = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
      fakeState.confidential = { account: { nexus: { OAuthCredentials: { token: fakeToken } } } };
      vi.mocked(control.queryStatePath).mockReturnValueOnce(fakeState);

      const res = await request({
        headers: jsonHeaders,
        body: {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "vortex_query", arguments: { path: [] } },
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(fakeToken);
      expect(res.body).toContain("[redacted: state.confidential]");
    });

    it("does not redact ordinary values that happen to be long strings", async () => {
      fakeState.confidential = { account: { nexus: { APIKey: "short-and-irrelevant" } } };
      const longButUnrelated = "this is a perfectly normal long mod description string";
      vi.mocked(control.querySelector).mockReturnValueOnce(longButUnrelated);

      const res = await request({
        headers: jsonHeaders,
        body: {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "vortex_query", arguments: { selector: "profiles" } },
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain(longButUnrelated);
      expect(res.body).not.toContain("[redacted");
    });
  });
});
