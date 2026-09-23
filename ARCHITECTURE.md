# Architecture

Design rationale for how vortex-mcp reflects Vortex's API instead of
hand-wrapping it, and where that approach reaches its limits. See
[README.md](README.md) for install/usage.

## Reflection over hand-wrapping

`vortex_describe`/`vortex_query` replace one-tool-per-selector design in
favor of fewer, richer read primitives over reflection on the live
`@nexusmods/vortex-api` namespace, rather than a named MCP tool (and a
rebuild) per selector. `list_mods` stays hand-written because it performs a
real join (mod ↔ profile enabled-state, friendly name via `renderModName`)
that reflection can't do in one call.

`vortex_dispatch` extends the same principle to writes, trying five
fallback tiers in order by name: (1) a Redux `actions` creator, (2) a
same-named `api.ext.*` function, (3) a currently-registered event name via
`api.events.emit` — fire-and-forget by default, or awaited to real
completion when the caller passes a `"__CALLBACK__"` sentinel at the
position Vortex's own handler expects a Node-style `(err, result?) => void`
callback (e.g. `action="deploy-mods", args=["__CALLBACK__"]`), (4) a direct
method on the `api` object itself (e.g. `translate`, `sendNotification`,
`runExecutable`), and (5) a literal `"type:<TYPE>"` prefix, dispatching a
raw `{type, payload}` Redux action directly. None of the five tiers is
allowlisted — the security boundary is the loopback bind + bearer token
(see [README's Safety section](README.md#safety)); once an operator holds
the token they already have full write privileges, matching what a human
at Vortex's own UI can do. `ACTION_HINTS`/`EXTENSION_API_HINTS`/`EVENT_HINTS`
in `vortexControl.ts` document real positional argument order for the
subset this project has verified, surfaced via `vortex_describe`'s
`dispatchHints`/`extensionApiHints`/`eventHints`. An action/function/
event/method missing from these maps still dispatches fine; you just don't
get a pre-verified argument order.

Most action creators defined _inside_ an extension's own module (as opposed
to Vortex core) are never re-exported through `@nexusmods/vortex-api`, so
they're invisible to `vortex_describe`'s `actions` list entirely.
`scan_extension_actions` closes that gap by scanning every installed
extension's own compiled JS on disk (bundled + user-installed, both plain
files) for `createAction(TYPE, prepareFn)` call sites, recovering the real
type string and the prepare-function's payload shape — key names and
argument order survive minification even when parameter names get mangled,
since a minifier can't rewrite an object literal's keys without breaking
the payload contract. This is shape only, not reducer _behavior_: a
recovered shape like `{tutorialId, isOpen}` doesn't guarantee a field
always does what its name implies — verify with a state read before/after
your first real dispatch of anything newly discovered.

`vortex_query` stays genuinely read-only (`selector`/`path` modes, neither
can mutate anything), so it keeps working with no token at all; `api.ext`
calls go through `vortex_dispatch` instead, since they can have side
effects. `check_nexus_mod_updates` stays a dedicated write tool because it
does a real join no generic dispatcher can do in one call (resolving mod
ids to full `IMod` records and filtering to Nexus-sourced ones before
calling `nexusCheckModsVersion`).

The remaining hand-written write tools exist because they do a genuine join
or bit of orchestration that name-based reflection can't do in one call:
`setModsEnabled` takes `api` directly and must be awaited rather than
dispatched; `clone_profile` is a filesystem copy plus a dispatch;
`launch_game` resolves the active profile's configured tool through two
levels of settings state before running it.

A handful of `apiMethods` (`onStateChange`, `onAsync`, `registerProtocol`,
`registerRepositoryLookup` — see `vortex_describe`'s `listenerHints`) don't
perform a one-off action: they register a real JS function as a persistent
listener that keeps firing for the life of the Vortex process. A function
can't cross JSON-RPC and the MCP transport here is stateless, so
`vortex_dispatch`-ing one of these substitutes the `"__CALLBACK__"`
sentinel with a real callback that appends each firing to an in-process
ring buffer (capped at 500 entries, oldest dropped) and returns a
`listenerId` immediately. `poll_listener` reads that buffer back
non-destructively — repeated polling with the same `since` returns the
same entries, with the returned `lastSeq` fed back in to get only what's
new. This works across separate tool calls, including from more than one
agent at once, since there's no per-caller identity in this project's trust
model: any holder of the token can register or poll any listener.
`withPrePost` is excluded outright — it returns a wrapped function rather
than performing an action, which isn't serializable.

## When reflection can't reach something

A capability falls into one of three cases:

1. **A real join or orchestration reflection can't do in one call**
   (`list_mods`, `clone_profile`, `launch_game`,
   `check_nexus_mod_updates`). The underlying operation is fully reachable
   through `@nexusmods/vortex-api`; the tool just does more than one
   generic call's worth of work. Stays a vortex-mcp-side tool.
2. **A real Redux action exists, just not published through
   `@nexusmods/vortex-api`** — the common case for anything defined inside
   an extension's own module. `scan_extension_actions` + tier (5) closes
   this generically: no vortex-mcp code change needed per action.
3. **The capability isn't a plain Redux action at all.** The Vortex "files
   changed outside Vortex" deploy-blocking dialog is the concrete case: it
   resolves a private in-memory Promise captured in a module-scope closure,
   so no amount of raw dispatching from outside that module can reach it.
   Drive the rendered dialog through `ui_snapshot` and `ui_click`; its own event
   handler resolves that promise on a stock release. A core API addition may be
   useful upstream, but must never become a prerequisite for this suite. Put
   main-process-only operations such as screenshots in the harness over CDP.

Nexus mod search falls into the same non-reachable category, for a
different reason: it was evaluated across every layer that could
plausibly carry it (Vortex's `api.ext.nexus*` surface, the official Nexus
v3 REST API, Vortex's own in-app browser, Mod Organizer 2's integration)
and none of them expose it — the capability doesn't exist in Nexus's
public API at all, so there's no upstream surface for Vortex core to
expose via `registerAPI` either. Writing a search tool today would mean
scraping the website or calling Nexus's API directly with the raw key,
reopening the `state.confidential` exposure the Safety section closes. If
Nexus ever ships a search endpoint, the fix is the same shape as
`confirmExternalChanges`.

## UI transactions, transport, and login persistence

Each HTTP request has its own MCP server/transport; state listeners and UI refs
remain shared within the renderer. Refs include a renderer-lifetime identifier
and are invalidated by the next snapshot. Harness snapshot/action transactions
are serialized with dialog watchers so they cannot invalidate each other's refs.
Separate agent processes still need to coordinate access to the same instance.

The harness uses isolated userData/appData and a dedicated sandbox game for
account-free tests. In harness mode only, `authCache.ts` restores the current
OAuth credentials from a private local file and persists changes when Vortex
refreshes them. Logout leaves a tombstone that overrides stale snapshots. It
uses Vortex's own actions and refresh logic; no OAuth secret is returned by MCP.
Credentials are separate from profile snapshots so game changes and `--fresh`
do not restore old refresh tokens or copy another game's mods into a blank profile.

## Keeping the tools table in sync

`README.md`'s tools table is generated from the live server's own
`tools/list` response, the same ground truth `vortex_describe` reflects,
so it can't drift from the code the way a hand-transcribed table can.

```sh
pnpm run docs:tools          # regenerate the table (needs Vortex running with this extension loaded)
pnpm run docs:tools:check    # verify it's current; exits 1 if stale, prints what to run
```

This can't run in CI (no live Vortex instance there), so it's a local step
— after adding/changing/removing a tool, run `docs:tools` before
committing. The read/write access tier isn't part of MCP's `tools/list`
response, so it stays a small hand-maintained map inside the generator
script (`ACCESS_TIER` in `scripts/generate-readme-tools-table.mjs`).

## File map

- `src/vortexControl.ts` — `describeApi`/`querySelector`/`queryStatePath` reflect
  over `@nexusmods/vortex-api`'s live `selectors` object and the Redux state
  tree; everything else is a thin wrapper around specific selectors/actions
  (`switchProfile`, `setModsEnabled`) and Vortex's internal event bus
  (`api.events.emit`) for `deploy-mods`/`purge-mods`/`start-download`/
  `activate-game`, which have no plain dispatchable-action equivalent — this
  is the same interface Vortex uses internally to trigger them.
- `src/mcpServer.ts` — MCP tool definitions + a `NodeStreamableHTTPServerTransport`
  HTTP server, bound to `127.0.0.1` only. Stateless: a fresh transport is
  connected to the shared `McpServer` per request (`sessionIdGenerator:
undefined`), matching the 2026-07-28 spec's removal of sessions — there is
  no session state to leak, TTL, or clobber across requests.
- `src/index.ts` — the Vortex extension entry point (`context.once`). This
  has to run in the renderer process: the event listeners and Redux store
  this extension talks to are all renderer-side, so `onceMain` would produce
  a server that reads/writes nothing real.
- `restartVortex` (in `vortexControl.ts`) is the one function that reaches
  outside `@nexusmods/vortex-api` — it calls `window.api.app.relaunch()`,
  Vortex's own Electron preload bridge, the exact path behind Vortex's own
  "Restart now" button. Unlike vortex-api this isn't a published contract —
  it can change across Vortex releases without notice.
