---
name: vortex-dev
description: Fix a bug in Vortex, add a feature to it, or reproduce and test a change in the real app. Use for any request about Vortex's own behaviour — "this is broken", "add X to the mods page", "does Y still happen" — as opposed to work on this MCP/automation suite itself. Covers getting the fork cloned and built, making the change, and verifying it in a running Vortex.
---

# Working on Vortex itself

A request to fix, test or add something means **Vortex the application**, not
this automation suite — unless the user explicitly says otherwise. Do the whole
loop without asking: get the source, build it, run it, drive it, report what
actually happened.

## One-time: get the source

First read [the workflow guide](../../../harness/WORKFLOWS.md). After locating the
checkout, read and follow **Vortex's own `AGENTS.md`, `CLAUDE.md` when present,
and `docs/README.md`**, plus the task-specific documents they reference. These
are authoritative for Vortex development; this skill is an automation aid.
For UI features, load `docs/frontend.md`, `docs/testing.md`, and the applicable
design-system and supplied design documents before implementing.

```bash
pnpm run ai:source
```

Finds the operator's Vortex fork on GitHub, clones it to `.vortex-src/` inside
this repo, wires up `upstream`, installs and builds. If they have no fork it
stops and tells them how to make one — the suite builds _their_ fork, because
you cannot push to `Nexus-Mods/Vortex`.

It never searches the filesystem for a Vortex checkout. `.vortex-src` is the
only source tree, and it is gitignored.

`pnpm run ai:doctor` reports whether it is there before anything else.

## The loop

```bash
pnpm run ai:up            # drives .vortex-src automatically once it exists
pnpm run ai:watch         # reload on rebuild, in a second shell
```

Then make the change in `.vortex-src/`, rebuild, and the running app picks it up.

| Change               | Rebuild                              | Picked up by                      |
| -------------------- | ------------------------------------ | --------------------------------- |
| Renderer (React, UI) | `pnpm nx run @vortex/renderer:build` | `ai:watch` → renderer reload      |
| Main process         | `node src/main/build.mjs`            | full restart (`ai:down && ai:up`) |
| This extension       | `pnpm run build` (in this repo)      | `ai:watch` → renderer reload      |

Nothing in the renderer can reload main — `watch` says so explicitly rather than
reloading and appearing to do nothing.

## Verifying a change

For bugs, reproduce first and add a regression assertion. For features and design
implementation, state the acceptance criteria and test both behavior and visual
fidelity. Exercise relevant empty, populated, loading, error, and modal states
at different widths **and heights**, including equal-width/different-height
cases. See the state matrix in `harness/WORKFLOWS.md`.

If the kit lacks a capability needed for the request, implement it in this repo,
test it, and update the relevant instructions so later agents can reuse it.

Drive the real app rather than reasoning about the diff. See the
`drive-vortex` skill for the snapshot → act → wait loop, and:

```bash
pnpm run ai -- screenshot --label after
pnpm run ai -- responsive --screenshots     # if the change touches layout
```

Unit tests are scoped from the owning project directory — the root `test`
script runs the whole nx graph and cannot be narrowed:

```bash
cd .vortex-src/src/renderer && pnpm exec vitest run <path>
```

Be honest about which suite ran. A full `pnpm run verify` in Vortex can fail for
reasons that predate the change (broken bundled extensions with missing native
modules); say so rather than reporting it as a regression or hiding it.

For an upstream pull request, use `pnpm run ai -- pr-checks <pr>` before changing
code. It reports the exact head and failed workflow steps, including whether the
tests passed and only artifact post-processing failed.

## Before calling a PR ready

Follow "Before a Vortex pull request is ready" in `harness/WORKFLOWS.md`:

- A/B in the real app with `--production` builds.
- `pnpm run verify` on the exact commit.
- The E2E suite, against a master baseline.
- An adversarial review by a separate agent, with its findings addressed.

Report each result in the PR.

## More than one issue

Don't fix a batch of reported issues in one context. Triage them. Then hand each issue to a fresh
subagent, one at a time in the one checkout, and have each PR reviewed by another fresh agent.
Keep the kit changes and the app-driven gates in the orchestrating session. See "Several issues at
once" in `harness/WORKFLOWS.md`.

## Git

Branch from `master`; never commit to it. `origin` is the fork, `upstream` is
`Nexus-Mods/Vortex` — push to `origin`. Don't commit, push or open a PR unless
asked.

## Before blaming your change

`KNOWLEDGE.md` in this repo catalogues Vortex behaviours that fail _silently_ —
an extension parsed as ESM, a game that will not activate, a snapshot that comes
back empty. Several look exactly like a bug you just introduced. Check there
first.
