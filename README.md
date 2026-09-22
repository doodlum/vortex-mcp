# vortex-mcp

A [Vortex](https://www.nexusmods.com/about/vortex/) extension that runs an
MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server inside
Vortex, so an AI agent (Claude, etc.) can list, install, enable/disable,
deploy, and purge mods, and switch profiles/games — all through one local
endpoint, no clicking through the UI.

Source: https://github.com/alandtse/vortex-mcp · License:
[GPL-3.0](LICENSE.md) · Nexus:
https://www.nexusmods.com/games/site/mods/2263

## Status

Unit- and integration-tested — see `pnpm run test`. Every read tool and
every `vortex_dispatch` fallback tier has been verified against a real
Vortex install on a disposable test profile, with a `backup_state` snapshot
taken first. `launch_game` was verified end to end (deploy, launch, real
game process came up) since unlike everything else here it has a visible
real-world side effect. The `start-download` event (installing a mod from a
URL) is never exercised outside unit tests — it can trigger a blocking
"choose install type" modal for ambiguous archives, unsafe to risk
unsupervised.

## Driving the UI

Beyond reading and writing Vortex's state, the extension can drive its
**interface**: read what is on screen as an accessibility tree, click, type,
hover, scroll, resize the window and scan for responsive-layout breakage. It
runs in Vortex's renderer, so this is plain DOM work — no CDP attach and no
patched Vortex.

`harness/` adds what an extension cannot do: launch and cache a logged-in
instance, take screenshots, move a real mouse, and hot-reload changes.

```sh
pnpm run ai:doctor   # check the setup, print fixes
pnpm run ai:up       # start a ready-to-drive Vortex, logged in, game active
```

Working on **Vortex itself** rather than this extension? `pnpm run ai:source`
finds your Vortex fork on GitHub, clones it into `.vortex-src/` here, and builds
it; `ai:up` then drives that clone instead of the installed app.

Verified against the released Vortex 2.6.3 — cold start ~90-140s, warm ~10-20s.
See [harness/AGENTS.md](harness/AGENTS.md) for the operating manual and
[KNOWLEDGE.md](KNOWLEDGE.md) for the Vortex behaviours that will otherwise cost
you an afternoon.

## Stack

- TypeScript, bundled to a single CommonJS `dist/index.js` via `tsup`
- `@modelcontextprotocol/server` + `@modelcontextprotocol/node` — official MCP
  TypeScript SDK v2, implementing the
  [2026-07-28 MCP spec](https://modelcontextprotocol.io/specification/2026-07-28)
  (stateless Streamable HTTP — no `initialize` handshake session or session id)
- `@nexusmods/vortex-api` — Vortex's published extension API
- `vitest` for tests, `oxlint`/`oxfmt` for lint/format (matches Vortex's own
  toolchain)

## Install

```sh
pnpm install
pnpm run ci               # typecheck + lint + format:check + test + build
pnpm run install-plugin   # copy dist/ + info.json into %APPDATA%\vortex\plugins\vortex-mcp
```

Restart Vortex. The MCP server listens on `http://127.0.0.1:3701/mcp`
(override with `VORTEX_MCP_PORT`). `install-plugin` is a straight directory
copy for local development; `.github/workflows/release.yml` builds a
versioned zip in the same layout and attaches it to a GitHub Release on
every Conventional-Commit-worthy push to `main` (see
[Release process](#release-process)).

## Connect an MCP client

Streamable HTTP, so most clients connect natively:

```sh
claude mcp add --transport http vortex http://127.0.0.1:3701/mcp
```

If `VORTEX_MCP_TOKEN` is set (see [Safety](#safety)), every request —
including reads — needs the header, or the connection fails outright:

```sh
claude mcp add --transport http vortex http://127.0.0.1:3701/mcp \
  -H "Authorization: Bearer <token>"
```

For a stdio-only client, bridge with the off-the-shelf `mcp-remote`:
`{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:3701/mcp"] }`

## Tools

Read tools are always available. Write tools only exist — `tools/list` won't
even show them — when `VORTEX_MCP_TOKEN` is set (see [Safety](#safety)).

Generated from the live server's actual `tools/list` response — see
[Keeping the tools table in sync](ARCHITECTURE.md#keeping-the-tools-table-in-sync)
— rather than hand-transcribed, so it can't silently drift from the code.

<!-- TOOLS_TABLE_START -->

| Tool                          | Access | What it does                                                                                                                                 |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `vortex_describe`             | read   | Discover the live Vortex API surface: callable selector names (for vortex_query, with known caveats in `selectorHints`, e.g. selectorHints.… |
| `scan_extension_actions`      | read   | Discover real dispatchable Redux action type strings — and, where recoverable, their payload shape — by scanning every installed extension'… |
| `vortex_query`                | read   | Read Vortex state. Two modes: `selector` calls that named vortex-api selector as `(state, ...args)` (e.g. selector='activeProfileId', or se… |
| `list_profiles`               | read   | List Vortex profiles (defaults to every game; pass gameId to filter to one), with name, active status, and mod counts — a formatted join vo… |
| `list_mods`                   | read   | List mods for a game (defaults to the active game), with friendly names and enabled state for the active profile — a formatted join vortex_… |
| `list_load_order`             | read   | List the current Gamebryo/LOOT plugin load order (.esp/.esm/.esl), sorted by index.                                                          |
| `get_plugin_details`          | read   | Get the same rich per-plugin info Vortex's own Plugins tab shows — master list, LOOT messages/warnings, dirty-edit status (ITM/UDR), group,… |
| `list_categories`             | read   | List a game's mod categories (defaults to the active game), sorted by display order, with a mod count per category — a join vortex_query ca… |
| `list_downloads`              | read   | List the download queue/history for a game (defaults to the active game): name, state, progress percent, size, start time, installedModId —… |
| `find_stale_downloads`        | read   | Group downloads that came from the SAME Nexus mod page (not the same field list_downloads' installedModId reads — this groups by the Nexus…  |
| `list_notifications`          | read   | List Vortex's current notifications (errors, warnings, info) — what Vortex itself is currently flagging as a problem, useful for diagnosing… |
| `list_mod_rules`              | read   | List a mod's dependency/conflict rules (before/after/requires/conflicts/...), resolving each reference to the target mod's friendly name wh… |
| `find_mod_dependents`         | read   | Find every OTHER installed mod whose own rules reference this one — the reverse of list_mod_rules, which only shows rules recorded ON the m… |
| `find_mod_by_file`            | read   | Find which installed mod(s) contain a file with this name, by scanning mod staging folders on disk (no reflectable API exposes this).        |
| `list_file_conflicts`         | read   | List files provided by more than one currently-enabled mod (for the active/given profile) — the read side of conflict resolution; found by…  |
| `find_missing_masters`        | read   | Find enabled plugins whose master files aren't themselves enabled — reads each plugin's real TES4 header from the game's Data folder (the B… |
| `list_runtime_errors`         | read   | Read recent Papyrus error lines and crash log excerpts from the game's real save-data folder (Documents/My Games/<game>) — Vortex has no co… |
| `list_duplicate_mods`         | read   | Find installed mods that look like duplicates or redundant leftovers — never auto-resolved, purely informational (same 'report candidates,…  |
| `find_stale_mods`             | read   | List DISABLED mods for a profile (defaults to the active one), sorted oldest-disabled first — candidates for actually removing rather than…  |
| `list_known_mod_conflicts`    | read   | Surfaces real 'conflicts'-type rules Vortex already has recorded on enabled mods (mod.rules — the same field list_mod_rules reads, often po… |
| `list_unsolved_conflicts`     | read   | List file conflicts between enabled mods that have NO rule resolving them yet — the read side of Vortex's own conflict-resolution ('Set Rul… |
| `find_missing_deployed_files` | read   | Find plugins where Vortex's load-order state, what's actually deployed to the game's Data folder, and what the game's own plugins.txt says…  |
| `find_orphaned_files`         | read   | Find files Vortex's own deployment manifest (<Data>/vortex.deployment.json — the same bookkeeping Vortex reads for its own Purge) still att… |
| `check_nexus_mod_updates`     | read   | Check installed Nexus-sourced mods for available updates via Vortex's own built-in integration and the user's existing Vortex login — no se… |
| `list_dialogs`                | read   | List Vortex's currently-open GENERIC modal dialogs (showDialog-based — most confirmation/question/error prompts) — distinct from list_notif… |
| `list_external_changes`       | read   | List pending 'external changes' Vortex detected (a deployed file differs from what Vortex itself put there) that are BLOCKING an in-progres… |
| `switch_profile`              | write  | Switch Vortex to a different profile by id (query list_profiles to find one).                                                                |
| `clone_profile`               | write  | Clone an existing profile into a new one (copies its on-disk profile directory — load order, ini tweaks — plus its mod enabled-state), the…  |
| `vortex_dispatch`             | write  | Dispatch a named Vortex action creator, api.ext function, event, or direct api method — tried in that order.                                 |
| `poll_listener`               | write  | Read back what a persistent listener registered via vortex_dispatch (onStateChange/onAsync/registerProtocol/registerRepositoryLookup) has c… |
| `backup_state`                | write  | Create a full snapshot of Vortex's settings/persistent/app/user state as a JSON file in Vortex's own backup folder (%APPDATA%/vortex/temp/s… |
| `set_mods_enabled`            | write  | Enable or disable a set of mods for a profile (defaults to the active profile).                                                              |
| `launch_game`                 | write  | Launch a game's configured primary tool (e.g. SKSE, or the vanilla exe if none is set) — the same operation as Vortex's own 'Play' button,…  |
| `vortex_restart`              | write  | Restart Vortex via its own graceful relaunch (same path as Vortex's 'Restart now' button): closes windows and lets Vortex's normal shutdown… |

<!-- TOOLS_TABLE_END -->

`vortex_describe`/`vortex_query` are reflection-based read primitives over
the live `@nexusmods/vortex-api` namespace; `vortex_dispatch` extends the
same principle to writes, trying five fallback tiers (action creator,
`api.ext` function, event, direct api method, raw `type:` dispatch) with
no allowlist — the security boundary is the token (see
[Safety](#safety)). See [ARCHITECTURE.md](ARCHITECTURE.md) for the full
design rationale, the fallback-tier order, and where reflection reaches
its limits (including why Nexus mod search isn't supported).

## Release process

`.github/workflows/release.yml`: `semantic-release` reads Conventional
Commit history on every push to `main`, and — if there's anything
releasable — picks the next version, bumps it in `package.json`/`info.json`,
commits that back (`[skip ci]`), tags `vX.Y.Z`, and opens a draft GitHub
Release with the generated changelog as its body. A second job then checks
out that exact tag, runs the full `pnpm run ci` pipeline, zips `dist/` +
`info.json` into the same layout `install-plugin` uses, attaches it to the
release, and promotes the release out of draft — only after the asset
exists, so a failed build leaves a hidden draft instead of a
download-less tag.

`.github/workflows/nexus-upload.yml` wraps `alandtse/nexus-workflows`'s
`upload-nexus-official.yml` (the official `Nexus-Mods/upload-action`, Nexus
v3 API). The mod page (`nexus_mod_id` 2263) and file group (`file_group_id` 7907967) both exist and are set as the workflow's defaults. Dry-run stays
the default until the `NEXUS_AUTO_UPLOAD=true` repo variable (plus
`UNEX_APIKEY`) is set, letting `release.yml` upload every subsequent
version automatically.

## Safety

Bound to `127.0.0.1` only; `localhostHostValidation()` / `localhostOriginValidation()`
(from `@modelcontextprotocol/node`) reject any request whose `Host`/`Origin`
hostname isn't `localhost`/`127.0.0.1`/`[::1]` — this, not the loopback bind
alone, is what stops a DNS-rebinding page from reaching the server as
same-origin.

**Writes fail closed on `VORTEX_MCP_TOKEN`.** With no token set, only the
read tools — every tool marked `read` in the [Tools](#tools) table above —
are ever registered; none of the eight write tools (`switch_profile`,
`clone_profile`, `vortex_dispatch`, `poll_listener`, `backup_state`,
`set_mods_enabled`, `launch_game`, `vortex_restart`) exist to call. Set
`VORTEX_MCP_TOKEN` to require `Authorization: Bearer <token>` on every
request (reads included) _and_ unlock the write tools. There is no
per-tool authorization once a token is set — any client holding it has
full write privileges, including `vortex_restart` (kills and relaunches
the whole app), and — via `vortex_dispatch` — every Redux action,
`api.ext` function, event, and direct api method Vortex has, including
ones that touch game/install paths, extensions, and credentials. This is
deliberate: the token represents the same trust a human already has at
Vortex's own UI. Acceptable for a local single-user tool; do not bind this
to a non-loopback address, and treat the token like any other local
secret.

**One exception to "no per-tool restriction": `state.confidential` (the
Nexus API key or OAuth credential Vortex itself stores) is redacted out of
every `vortex_query` response, token or no token.** Redaction happens in
`mcpServer.ts`'s `jsonText` — the one funnel every tool response already
serializes through — by provenance: anything sourced from the live
`state.confidential` subtree (matched structurally for objects, by value
for a freshly-computed string like `apiKey`'s return) becomes
`"[redacted: state.confidential]"` before it's ever written to the wire.
Selectors that legitimately derive a non-secret fact from that subtree
(`isLoggedIn`) are unaffected — the redaction runs on the _output_, after
the selector already ran on real state. This is a token-independent
invariant: a human at Vortex's own UI can't read their stored credential
back out as plaintext either. `vortex_dispatch` can still _write_ new
credentials (`setUserAPIKey`, `nexusRequestNexusLogin`, …) — the boundary
is specifically on reading one back out.

**Writes can optionally guard against a stale assumption about what's
currently active.** `switch_profile`, `set_mods_enabled`, `launch_game`,
and `vortex_dispatch` all accept optional
`expectedActiveProfileId`/`expectedActiveGameId` params; when set, the
write throws immediately — before touching anything — if the live active
profile/game no longer matches what the caller last observed, instead of
silently proceeding against whatever's active now. Opt-in and additive:
omit them and behavior is unchanged.

## License

GPL-3.0-only, matching Vortex core and `@nexusmods/vortex-api` (both
GPL-3.0-only with no extension-linking exception).
