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
pnpm run ai -- doctor --installed --sandbox
pnpm run ai -- setup --installed --sandbox  # no game or account required
pnpm run ai -- tools --json                # live tool schemas for any agent
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

Local automation needs no account. Collections use OAuth, whose browser flow
can require password, MFA or captcha input from the account owner during setup:

```bash
pnpm run ai -- setup --installed --oauth
# ... complete Log in in Vortex and the browser; setup waits and caches it ...
```

Current OAuth credentials are cached privately, updated when Vortex refreshes
them, and reused on cold and fresh starts. Revoked sessions may require repeating
setup. `auth-status` returns presence booleans without secrets. See
`harness/AGENTS.md` for details and recovery.

A legacy API key can optionally be stored in gitignored `harness/.env`; it is
not required for local tests and is not a substitute for collection OAuth.
Use `pnpm run ai:test:nexus` for the live collection smoke test after setup.

## Verification

`pnpm run ci` — typecheck (extension + harness), lint, format check, unit tests,
build. This is the gate; it needs no Vortex.

`pnpm run ai:test` runs the Playwright suite against a real Vortex. Deliberately
outside `ci`: it needs Vortex and Electron startup. It supplies a disposable
test game and needs no account. Say
which one you ran.

Formatting and lint are owned by oxfmt and oxlint. Don't hand-fix them.

## Working on this repo

### Every automation request improves the automation kit

When someone asks an AI to perform or test something in Vortex:

1. Read `harness/AGENTS.md`, review the available skills in `.claude/skills/`,
   and apply the relevant ones. Read `KNOWLEDGE.md` before diagnosing a failure;
   use `ARCHITECTURE.md` to choose where a missing capability belongs.
   For Vortex application development, also read and follow its own
   `.vortex-src/AGENTS.md`, `.vortex-src/CLAUDE.md` when present, and
   `.vortex-src/docs/README.md`, then load the task-specific documentation they
   reference. This harness supplements Vortex's AI guidance; it does not replace
   its development, design, testing, or verification rules.
2. Inspect the live tool schemas (`pnpm run ai -- tools --json`), state, and UI
   before choosing actions. Use existing supported capabilities first.
3. If the request cannot be completed because this kit lacks a capability,
   **implement that capability here**, including extension tools, harness
   orchestration, or setup support as appropriate. Keep compatibility with stock
   Vortex. Do not stop at describing the gap or make a private, undocumented
   workaround that the next agent cannot reuse.
4. Verify the new path through the real app when available, add regression
   coverage for the failure, and update the operating manual, relevant skill,
   and knowledge entries so the next agent can do it without rediscovery.
5. Distinguish missing automation from an external constraint. Account login,
   captcha, unavailable services, and software the user must install cannot be
   made successful by claiming otherwise. Put unavoidable interaction in initial
   setup, preserve reusable authentication, and report any remaining limitation
   with the exact setup step needed.

The requested task is complete only when its result is verified, or when a
concrete external blocker is clearly reported. Passing unit tests alone is not
evidence that a Vortex workflow works end to end.

Use [harness/WORKFLOWS.md](harness/WORKFLOWS.md) for bug reproduction, regression
tests, new features, implementation from design documentation, and checks across
window widths, heights, and application states.

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
