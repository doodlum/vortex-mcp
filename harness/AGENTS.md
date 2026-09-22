# AI testing & automation harness

Drive Vortex's UI from an AI agent: read what is on screen, click and type,
resize the window, test responsive layout, hot-reload changes, and get from a
cold machine to a logged-in, game-managed instance with no human in the loop.

**It drives the Vortex you already have installed.** No patched build, no source
checkout, no fork of Vortex. Verified against the released 2.6.3.

If you read one section, read [What you have to provide](#what-you-have-to-provide)
and [Quick start](#quick-start).

## How it fits together

```
  agent (Claude, etc.)
        │  MCP over HTTP — 127.0.0.1:3701
        ▼
  ┌────────────────────────────────────────────┐
  │ Vortex (the installed one)                 │
  │   renderer ── vortex-mcp extension         │  ← state AND the DOM
  └────────────────────────────────────────────┘
        ▲                        ▲
        │ spawn / cache / reload │ CDP :9222 — screenshots, real hover
        └──────── harness/ ──────┘   `vortex-ai`
```

**The extension** (`../src`) runs inside Vortex's renderer, alongside its React
tree, so it can read the Redux store and touch the DOM directly. That is why an
agent can drive a user's real, already-running Vortex.

**The harness** (this directory) does what an extension cannot: start a process,
build a bundle, cache a profile, take screenshots, and move a real mouse.

Two capabilities genuinely need the harness, and both go through CDP rather than
a change to Vortex:

- **Screenshots.** `webContents.capturePage` is main-process only, and Vortex
  extensions are renderer-only (`onceMain` is deprecated). Electron parses
  `--remote-debugging-port` from argv even in a released build, so the harness
  launches Vortex with it and Playwright attaches.
- **Real hover.** See [the hover trap](#the-hover-trap).

## What you have to provide

**One of these**, depending on what you are doing:

- **Driving Vortex** (the common case) — an installed Vortex:
  <https://www.nexusmods.com/about/vortex/>
- **Working on Vortex** — a GitHub fork of `Nexus-Mods/Vortex`. Run
  `pnpm run ai:source` and it finds your fork, clones it to `.vortex-src/`
  inside this repo, and builds it. No fork yet? It stops and tells you how to
  make one; the suite builds _your_ fork because you cannot push to upstream.

Plus, for anything that talks to Nexus: **a Nexus Mods personal API key.**

Everything else works signed out: driving the UI, managing a game, installing a
mod from a local archive, deploying, purging, responsive testing, hot reload.

```bash
echo 'VORTEX_AI_NEXUS_API_KEY=<your key>' >> harness/.env   # gitignored
```

### The rule for credentials

**Check for a key before starting anything that needs one, and if it is absent,
ask the user for it.** A key is the user's credential: it cannot be guessed,
derived, or read out of an existing Vortex install, so there is nothing to fall
back on and nothing to infer. `requireApiKey()` is that check, and Nexus-facing
commands call it before they launch or connect to anything — a run that is going
to fail on authentication should say so up front, not after a cold start and a
rejected download.

Store it once in `harness/.env`. It is gitignored, it survives `up --fresh`, and
every later run reuses it. Never commit it, and never print it.

### An API key is not enough for collections

Vortex's `isLoggedIn` is
`truthy(state.confidential.account.nexus.APIKey) || truthy(...OAuthCredentials)`,
so an API key satisfies it — no browser, no redirect, **no captcha** — and that
is enough for the API calls the harness makes directly.

It is **not** enough to download a collection. This Vortex build authenticates
that path with OAuth, so with only an API key the download is dispatched and
then fails with a 401, surfaced as _"You are not logged in to Nexus Mods!"_ —
long after `isLoggedIn` said yes. `installCollection` therefore checks for
`OAuthCredentials` specifically and refuses up front.

OAuth means the captcha, which is exactly why Vortex's own E2E suite has an
interactive `auth:capture` step a human sits through. So **collections cannot be
installed "from scratch with no user input"** on this build: someone has to click
Log in once. That login lives in the live instance and does _not_ survive
`up --fresh`, which re-seeds from the snapshot.

Everything else in this suite still meets the no-user-input bar.

### Everything else is checked for you

```bash
pnpm run ai:doctor
```

Reports every prerequisite — which Vortex it found, the extension build, the
game install, the profile cache, whether an instance is already running — and
prints the exact command that fixes each missing one.

## Quick start

```bash
pnpm install
pnpm run build        # build the extension
pnpm run ai:doctor    # check the setup
pnpm run ai:up        # start a ready-to-drive Vortex

# point your agent at it — `ai:up` prints this line with your token
claude mcp add --transport http vortex http://127.0.0.1:3701/mcp \
  -H "Authorization: Bearer <token>"
```

The agent now has ~45 tools: the state tools (mods, profiles, load order,
conflicts, diagnostics) plus the UI tools below.

## Cold vs warm start

Paid once per machine per (API key, game); everything after is warm.

| Tier      | What happens                                                                      | When                               |
| --------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| **cold**  | Launch a blank Vortex, seed the API key and game over MCP, quit cleanly, snapshot | first run, or `--rebuild-snapshot` |
| **reset** | Copy the snapshot over the working directory, launch                              | `--fresh`                          |
| **warm**  | Launch the existing working directory as-is                                       | every other run                    |

Measured against Vortex 2.6.3: **cold ~90-140s, warm ~10-20s.** A warm start is
just Electron booting — nothing is copied, so a previous session's mods are
still there. `--fresh` gets back to a clean logged-in state (the snapshot is a
few hundred KB, so the copy is effectively instant).

### Why not seed Vortex's database directly?

Faster still, and rejected. Vortex persists state in DuckDB through a
`level_pivot` extension, keyed `hive###path###parts` — version-coupled to
Vortex, and a desync would surface as mysterious data loss rather than an error.
Letting Vortex write its own state once and copying the result cannot drift.

Instances are fully isolated: `ELECTRON_USERDATA`/`ELECTRON_APPDATA` point at
`harness/.cache/`, so **your real Vortex install is never touched**, and both can
run at once. (Those variables are honoured by the released build, not just a
source checkout — which is what makes isolated automation possible at all.)

## Driving the UI

### The loop

1. `ui_snapshot` — see what is on screen, and get a `ref` per element
2. `ui_click` / `ui_fill` / `ui_press_key` — act on a `ref`
3. `ui_wait_for` — wait for the result
4. back to 1

Refs are **generation-scoped**: every `ui_snapshot` invalidates the previous set.
Deliberate — Vortex's mod and plugin tables are virtualised, so the element
behind a given row index is genuinely recycled as the list scrolls. A
silently-reused ref would click the wrong mod. A stale ref throws instead.

### Tools

Read tier — always available:

| Tool                      | What it gives you                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ui_snapshot`             | Accessibility tree of what is rendered, with a `ref` per node. Layout wrappers collapsed. Open modals surfaced as `activeDialogs`. |
| `ui_wait_for`             | Poll a selector or text to `visible`/`hidden`/`attached`/`detached`. Returns `matched: false` on timeout rather than throwing.     |
| `ui_get_viewport`         | Window outer size, renderer inner size, device pixel ratio.                                                                        |
| `ui_detect_layout_issues` | Overflow, clipped text, offscreen elements, sub-24px tap targets.                                                                  |
| `ui_read_console`         | Renderer console and uncaught errors, ring-buffered. The only way to see a React error over MCP.                                   |

Write tier — needs `VORTEX_MCP_TOKEN`, which `ai:up` sets for you:

| Tool                  | Notes                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui_click`            | Full pointer/mouse sequence, not `el.click()` — several Vortex widgets listen on `mousedown` only. `modifiers` for ctrl-click multi-select. |
| `ui_fill`             | Goes through React's native value setter, so `onChange` actually fires.                                                                     |
| `ui_press_key`        | DOM key events. Does **not** reach native menus or OS file dialogs.                                                                         |
| `ui_hover`            | JS hover handlers only — see [the hover trap](#the-hover-trap).                                                                             |
| `ui_select_option`    | Native `<select>` only. Vortex's custom dropdowns need click-then-click.                                                                    |
| `ui_scroll`           | Also fires a `scroll` event, which is what makes virtualised tables mount newly-revealed rows.                                              |
| `ui_set_viewport`     | Resizes the real window. Unmaximises first.                                                                                                 |
| `ui_responsive_sweep` | Resize through sizes, scanning each, then restore. Structure only.                                                                          |
| `ui_reload_renderer`  | Hot-reload the renderer (and with it, extensions).                                                                                          |
| `vortex_quit`         | Clean shutdown that flushes state.                                                                                                          |

Screenshots are a harness command (`vortex-ai screenshot`), not a tool — they
need CDP.

### From a shell, without an agent

Every UI tool has a CLI equivalent. Fastest way to tell a broken harness from a
broken MCP client config:

```bash
pnpm run ai -- snapshot            # what is on screen
pnpm run ai -- click --ref e42
pnpm run ai -- fill --ref e17 --value "vintage"
pnpm run ai -- press --key Escape
pnpm run ai -- screenshot --label before
pnpm run ai -- tools               # everything the instance exposes
```

## The hover trap

`ui_hover` dispatches `pointerover`/`mouseover`/`mouseenter`. Those run React's
handlers, but they **do not change the browser's own hover state** — so anything
revealed purely by a CSS `:hover` rule stays hidden.

Vortex's game tiles are exactly this: the "Manage" button lives in a
`.hover-content` wrapper at `opacity: 0`. After `ui_hover` the button is in the
DOM but correctly reported as hidden, which reads like a bug in the snapshot and
is not.

Two ways through:

- `ui_click` with `requireActionable: false` — the click handler fires
  regardless of opacity, because the event is dispatched on the element rather
  than at a screen coordinate.
- The harness's `realHover()`, which drives a real mouse over CDP. This is what
  the first-time game-manage flow uses.

## Testing a change

```bash
pnpm run ai:watch          # reload the instance whenever the extension rebuilds
pnpm run dev               # in another shell: tsup --watch
```

`watch` polls build _output_ and calls `ui_reload_renderer` when it changes.
Reloading the renderer re-runs extension initialisation, so your new tool code is
live without restarting Vortex. It deliberately does not own the build, so it
composes with whatever produced the output.

Working on **Vortex itself** rather than the extension? Once `ai:source` has
cloned it, `ai:up` drives that clone automatically and `watch` also watches
Vortex's own renderer bundle:

```bash
pnpm run ai:source        # once
pnpm run ai:up            # now targets .vortex-src
pnpm run ai:watch
```

`--installed` forces the released build back to the front when you want it.

A change to Vortex's **main** process can never be hot-reloaded — nothing in the
renderer can reload main — so `watch` says so explicitly instead of reloading and
appearing to do nothing.

## Running the test suite

```bash
pnpm run ai:test
```

Playwright specs that drive Vortex through the MCP `ui_*` tools and verify the
result through Playwright's own view of the DOM. The two halves are separate on
purpose: asserting an MCP tool's effect with the same MCP tools would pass even
if both sides were wrong together.

Not part of `pnpm run ci` — it needs a real Vortex and minutes of startup. Point
it at a disposable game directory first (see below).

## Responsive testing

```bash
pnpm run ai -- responsive --screenshots
pnpm run ai -- responsive --viewports 1024x720,1920x1080 --strict
```

Defaults to 1024x720, 1280x800, 1600x900, 1920x1080, and restores the original
size afterwards — even if the sweep fails partway.

The output separates **width-dependent** issues from ones present at **every**
width, and that distinction is the whole value. An issue at every size is almost
always a pre-existing quirk (a deliberately-scrollable pane, an icon button that
is simply small). One that appears only below some width is the actual
responsive regression. Findings are heuristic and advisory; `--strict` exits
non-zero on width-dependent ones.

## Deploying into a game your own Vortex manages

Vortex refuses to deploy over files another instance deployed, and prompts:
_"Purge files from different instance?"_. The harness answers **Cancel**
automatically and says so. Not a formality — on the machine this was built on,
the operator's real Fallout 4 had **31,102 files** deployed by their own Vortex,
and answering "Purge" unattended would have removed them.

So **installs and enables work against your real game; deploys do not.** To
exercise deploy and purge for real, point at a disposable copy:

```bash
mkdir -p "C:/dev/vortex-ai-sandbox/Fallout 4/Data"   # a stub exe is enough
pnpm run ai -- up --game-path "C:/dev/vortex-ai-sandbox/Fallout 4"
```

Everything else is identical; only deployment cares which directory it writes to.
If you genuinely want the harness to take over your real install, purge from your
own Vortex first (the reliable direction Vortex recommends), then start it.

## Safety

The MCP server binds `127.0.0.1` only and rejects any request whose `Host` or
`Origin` is not localhost — that, not the loopback bind, is what stops a
DNS-rebinding page reaching it.

**Write tools do not exist without `VORTEX_MCP_TOKEN`.** With no token they are
never registered; `tools/list` will not even show them. Any client holding the
token has the same power a human at Vortex's UI has.

**The stored Nexus credential is redacted from every read**, token or not.

Your API key lives in `harness/.env`; the cached profile is under `.cache/`. Both
gitignored. The snapshot marker stores only a hash of the key.

## Environment variables

| Variable                  | Default               | Purpose                                                   |
| ------------------------- | --------------------- | --------------------------------------------------------- |
| `VORTEX_AI_NEXUS_API_KEY` | —                     | Nexus personal API key. The only secret.                  |
| `VORTEX_MCP_TOKEN`        | derived from hostname | Bearer token gating write tools.                          |
| `VORTEX_MCP_PORT`         | `3701`                | MCP port.                                                 |
| `VORTEX_AI_CDP_PORT`      | `9222`                | CDP port for screenshots and Playwright.                  |
| `VORTEX_AI_EXE`           | auto-detected         | A specific Vortex.exe.                                    |
| `VORTEX_AI_DEV_DIR`       | —                     | A Vortex source checkout, instead of the installed build. |
| `VORTEX_AI_GAME_ID`       | `fallout4`            | Game to manage.                                           |
| `VORTEX_AI_GAME_PATH`     | located via Steam     | Explicit game directory.                                  |
| `VORTEX_AI_CACHE_DIR`     | `harness/.cache`      | Snapshot + working directory.                             |
| `VORTEX_AI_ARTIFACT_DIR`  | `harness/.artifacts`  | Screenshots, sweep reports.                               |
| `VORTEX_AI_HEADLESS`      | off                   | Hide the window. Screenshots may come back blank.         |

## Troubleshooting

**"Could not find an installed Vortex"** — install it, or set `VORTEX_AI_EXE`.

**"No Vortex instance is answering"** — nothing running, or a different port.
`pnpm run ai -- status`.

**MCP answers but there are no `ui_*` write tools** — Vortex was launched without
`VORTEX_MCP_TOKEN`, so the server is read-only. Start it through `ai:up`.

**"vortex-mcp did not become ready"** — Vortex started but its renderer never got
far enough to load extensions. Read `.cache/live/userData/vortex.log`.

**403 from the MCP server** — the client's token does not match the one Vortex was
launched with. Re-run `ai:up` and use the `claude mcp add` line it prints.

**"Vortex did not make \<game\> the active game"** — activation is blocked on a
modal. The error prints the open dialogs and notifications.

**A previous run left Vortex running** — `up` detects and stops it, over MCP when
it answers and by recorded PID when it does not. The PID path matters: an
instance whose extension failed to load holds the user-data directory while
answering nothing.

See [KNOWLEDGE.md](../KNOWLEDGE.md) for the non-obvious Vortex behaviours behind
several of these.
