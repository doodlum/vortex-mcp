---
name: drive-vortex
description: Drive a real Vortex instance through its UI — read what is on screen, click, type, resize, screenshot, install mods, manage games. Use when the user asks to control, inspect, test or demo Vortex's interface, reproduce a UI bug, check responsive layout, or verify a change in the running app. Also use when an MCP call to a ui_* tool fails and you need the right recovery.
---

# Driving Vortex

You control Vortex through the `vortex-mcp` extension's MCP tools. Read
[KNOWLEDGE.md](../../../KNOWLEDGE.md) before debugging anything that looks
impossible — most Vortex surprises are catalogued there.

## Get an instance up

```bash
pnpm run ai -- doctor --installed --sandbox
pnpm run ai -- setup --installed --sandbox  # no game or account needed
pnpm run ai -- tools --json                # all live input schemas
```

Use `setup --installed --oauth` for initial Nexus login; it waits and caches
automatically. `up` reuses a matching working profile; `up --fresh` resets it.
Without `--installed`, the managed `.vortex-src` clone takes precedence.
Read [harness/AGENTS.md](../../../harness/AGENTS.md) and
[WORKFLOWS.md](../../../harness/WORKFLOWS.md) before starting. If a requested
workflow cannot be completed with existing tools, implement the reusable missing
capability, test it, update the instructions, and resume the original request.

## The loop

1. `ui_snapshot` — what is on screen, with a `ref` per element
2. `ui_click` / `ui_fill` / `ui_press_key` on a `ref`
3. `ui_wait_for` for the result
4. snapshot again

**Refs die on the next snapshot.** That is deliberate: Vortex's tables are
virtualised and recycle rows, so a reused ref would act on the wrong mod. After
any action that re-renders, snapshot again before acting.

## Rules that save time

- **Check `activeDialogs` first** when a click seems to do nothing. A modal is the
  most common blocker. `ui_press_key --key Escape` usually clears it.
- **Filter, don't scroll.** Virtualised rows are absent from the DOM until the
  list is narrowed. Use the search box.
- **`ui_hover` cannot trigger CSS `:hover`.** For controls hidden at `opacity: 0`
  until hover (Vortex's game tiles), either `ui_click` with
  `requireActionable: false`, or use the harness's `realHover()` over CDP.
- **`ui_press_key` never reaches an OS dialog.** Native file pickers and menus
  are out of reach; use `vortex_dispatch` instead.
- **State and screen disagree, legitimately.** `vortex_query`/`list_mods` tell you
  what Vortex believes; `ui_snapshot` tells you what it is showing. A pending
  render or an active filter explains most differences.

## Screenshots

Not an MCP tool — they need CDP:

```bash
pnpm run ai -- screenshot --label before
```

## Don't destroy the user's setup

The harness auto-answers Vortex's _"Purge files from different instance?"_ with
**Cancel**. Leave it that way. A real install can have tens of thousands of
deployed files, and purging unattended removes them. To test deployment, use a
disposable game directory:

```bash
pnpm run ai -- up --installed --sandbox
```

## When it goes wrong

For real Nexus collections use their real game ID and a disposable game copy;
the sandbox game is for local archive and deployment tests. A copied executable
does not isolate game-specific writes to Documents or LocalAppData.

Read the error — they are written to be actionable. Then:

| Symptom                | Cause                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| No `ui_*` write tools  | Launched without `VORTEX_MCP_TOKEN`; use `ai:up`                          |
| 403                    | Client token ≠ launch token; re-run `ai:up`                               |
| "did not become ready" | Renderer never loaded extensions — read `.cache/live/userData/vortex.log` |
| Snapshot looks empty   | See KNOWLEDGE.md → "Three ways a snapshot can silently go blank"          |
| Game never activates   | A modal is blocking; the error prints which                               |

Full manual: [harness/AGENTS.md](../../../harness/AGENTS.md).
