# Agent instructions

This repo is a self-contained automated development and testing suite for
Vortex. It holds the tools, the harness, the docs and the hard-won knowledge —
nothing here requires a patched or self-built Vortex.

## What's here

| Path                | What it is                                                                       |
| ------------------- | -------------------------------------------------------------------------------- |
| `src/`              | The Vortex extension: an MCP server exposing Vortex's state **and** its UI       |
| `harness/`          | `vortex-ai` CLI + Playwright suite — launching, caching, screenshots, hot reload |
| `harness/AGENTS.md` | **The operating manual.** Start here to actually use any of this                 |
| `KNOWLEDGE.md`      | Non-obvious Vortex behaviours that fail silently. Read before debugging          |
| `ARCHITECTURE.md`   | Why the extension reflects Vortex's API instead of wrapping it                   |
| `.claude/skills/`   | Skills for driving Vortex and writing UI tests                                   |

## Getting to a driveable Vortex

```bash
pnpm install
pnpm run build
pnpm run ai:doctor    # reports every prerequisite and how to fix it
pnpm run ai:up        # prints the `claude mcp add` line for your agent
```

Requires an **installed** Vortex (<https://www.nexusmods.com/about/vortex/>).
A Nexus API key is optional and only enables Nexus downloads.

## Verification

`pnpm run ci` — typecheck (extension + harness), lint, format check, unit tests,
build. This is the gate; it needs no Vortex.

`pnpm run ai:test` runs the Playwright suite against a real Vortex. Deliberately
outside `ci`: it needs an install, a game, and minutes of Electron startup. Say
which one you ran.

Formatting and lint are owned by oxfmt and oxlint. Don't hand-fix them.

## Working on this repo

- **The extension must keep working against a stock, released Vortex.** That
  constraint is the reason this design is worth anything. Anything needing the
  main process goes in the harness over CDP, never into a patch to Vortex.
- **Two test layers.** Pure DOM logic → `src/uiAutomation.test.ts` under jsdom.
  Anything needing a real app → `harness/src/tests/`.
- **Add to KNOWLEDGE.md** when you lose an hour to something non-obvious. Every
  entry there cost real time; the file is the reason the next person doesn't
  pay it again.
- Extension changes hot-reload into a running instance: `pnpm run ai:watch`
  alongside `pnpm run dev`.

## Committing

Conventional Commits — `semantic-release` reads them to pick versions. Don't
commit, push or open a PR unless asked.
