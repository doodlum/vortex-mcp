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
| `.claude/skills/`   | Skills: working on Vortex, driving its UI, writing UI tests                      |
| `.vortex-src/`      | The Vortex clone this suite manages (gitignored, created by `ai:source`)         |

## Getting to a driveable Vortex

```bash
pnpm install
pnpm run build        # build the extension
pnpm run ai:doctor    # reports every prerequisite and how to fix it
pnpm run ai:up        # prints the `claude mcp add` line for your agent
```

That drives your **installed** Vortex
(<https://www.nexusmods.com/about/vortex/>).

To work on Vortex's own code instead:

```bash
pnpm run ai:source    # finds YOUR GitHub fork, clones it to .vortex-src, builds it
pnpm run ai:up        # now drives that clone
```

`ai:source` looks your fork up on GitHub from the identity git already knows —
no `gh auth login` needed — and stops with instructions if you do not have one
yet. It clones **inside this repo**; the suite never searches the filesystem for
a Vortex checkout, so there is exactly one source tree and it is gitignored.

## Signing in (one manual step, once per machine)

A Nexus API key covers most Nexus access:

```bash
echo 'VORTEX_AI_NEXUS_API_KEY=<key>' >> harness/.env   # gitignored
```

**Collections need more than that.** They are authenticated with OAuth, OAuth
means a captcha, and a captcha cannot be automated — so one interactive login
has to happen by hand:

```bash
pnpm run ai:up                 # start an instance
#  ... click Log in in Vortex, finish the flow in the browser ...
pnpm run ai -- save-login      # fold that login into the snapshot
```

After that every cold start, `up --fresh` included, comes up already signed in.
`up` nags on every start until it is done. See `harness/AGENTS.md` for why an
API key is not enough, and for what an agent can and cannot drive here.

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
