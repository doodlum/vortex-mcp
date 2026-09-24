# Developing and testing Vortex with AI

Use this kit for automated testing, reproducing and fixing bugs, implementing
features, comparing implementations to design documentation, and checking UI
behavior across window sizes and application states. Start with
[the operating manual](AGENTS.md), [known pitfalls](../KNOWLEDGE.md), and the
relevant skill in [`.claude/skills`](../.claude/skills/).

## Vortex's own AI documentation is required reading

Before editing Vortex, read and follow the source checkout's `AGENTS.md` and
any applicable nested instructions. Read `CLAUDE.md` when present and follow its
references. Start at `docs/README.md` for the documentation index; do not assume
that this harness's notes supersede Vortex's current instructions.

The current source tree routes these tasks to:

| Task                              | Vortex reference, relative to its checkout                                   |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Source layout and build setup     | `CONTRIBUTING.md`, `docs/repo-layout.md`                                     |
| React, UI, styling, accessibility | `docs/frontend.md`, `CODESTYLE.md`                                           |
| State changes and reducers        | `docs/state.md`                                                              |
| Regression and component tests    | `docs/testing.md`                                                            |
| Debugging and runtime diagnostics | `docs/DEBUGGING-GUIDE.md`                                                    |
| Design-system page work           | `docs/design-system/page-migration.md` and the supplied design specification |
| Collections and install flows     | `docs/mod-management/collections.md`                                         |
| Deployment and external changes   | `docs/mod-management/EXTERNAL-CHANGES.md`                                    |

Consult the checkout's index if paths move. Report missing design inputs or
contradictions explicitly; use the task's stated behavior as the acceptance
criteria. Do not silently replace a supplied design with a generic layout.

## Reproduce, change, verify

1. Identify the target: stock Vortex for an automation-tool issue; the source
   checkout for a Vortex application change. Record the version/commit, game,
   profile, current page, and relevant state.
2. Use the sandbox for local install/deploy/purge tests. Use an explicitly
   configured real game for game-specific behavior or game launch. Authentication
   is a setup concern; do not repeatedly ask for credentials while implementing.
3. Reproduce the symptom through MCP UI actions. Capture a before screenshot,
   a focused UI snapshot, relevant state, and renderer errors. Poll the specific
   outcome rather than sleeping for a guessed duration.
4. Add a regression assertion which fails for the original behavior. Put pure
   extension DOM tests in `src/uiAutomation.test.ts`, harness logic tests beside
   the implementation, Vortex code tests in the owning Vortex project, and real
   app workflows in `harness/src/tests/`.
5. Make the smallest complete change in the correct repository. Rebuild the
   relevant output. Renderer changes can be reloaded; main-process changes
   require a restart. Verify the new renderer lifetime before driving it.
6. Repeat the reproduction and assert the outcome independently: Playwright for
   rendered behavior, filesystem contents for deployment, a live game process
   for game launch. A tool returning success alone does not establish the result.
7. Run the repository's required checks and the relevant real-app tests. Record
   exactly which passed, failed, or were blocked, with artifact paths. Update the
   skill/manual when the workflow changed and add non-obvious findings to
   `KNOWLEDGE.md`.

If the kit cannot carry out a requested step, extend its reusable tools or
fixtures and cover that capability with tests. Do not leave a successful manual
experiment as the only way to reproduce a result. Preserve compatibility with
released Vortex; process control and CDP belong in the harness.

## Before a Vortex pull request is ready

A draft PR is not done until each of these is true and stated in its description:

1. **Reproduced and A/B-verified** in the real app, unpatched against patched. Use the same
   commit and the same `--fresh` baseline, with the relevant opt-in check or scenario.
   Timings come from `--production` builds, so React runs as it does for users.
2. **Vortex's full gate passes on the PR's exact commit.** Run `pnpm run verify`, and
   confirm the formatter left the tree clean. Stop the harness instance first, because
   verify rewrites `src/main/build`.
3. **The E2E suite has run** with the kit's runner, master first as the baseline:
   `pnpm run ai:vortex-e2e -- --owner <you> --checkout <dir>` on master, then the PR's head
   with `--compare <master report.json>`. It runs `packages/e2e` as CI does, with the
   fixture's startup race patched for the run only, and leaves out the account specs when
   their credentials are absent (they need Nexus test accounts and VPN). Report its
   regressions separately from pre-existing failures and the credential-skipped count,
   and give both HEAD shas.
4. **An independent agent has reviewed it adversarially**: the whole diff, claims and
   evidence, trying to break equivalence and find undisclosed behaviour changes. Fix or
   answer every confirmed point, then re-verify.

"Not run" is not an acceptable line in a PR description. If a gate cannot run here, say
exactly what blocked it.

Titles, the description template, the reviewer brief and the lessons log are in
[PULL-REQUESTS.md](PULL-REQUESTS.md). After every review, add any recurring class of finding to
its "Review lessons", so the next author checks for it before pushing.

## Several issues at once: orchestrate, don't accumulate

A report often names several problems: a slow deploy, a crash, a missing warning. Working them all in
one context degrades it. Findings, logs and diffs from one issue leak into reasoning about the next,
and review points get lost. Split the work:

- **The orchestrator** (the session the user is talking to) triages the report into one task per
  issue, keeps the list of open PRs and their state, and owns this kit. It is the only agent that
  edits `vortex-mcp`. It schedules every use of Vortex: A/B timing, `pnpm run verify`, E2E.
- **One fresh subagent per issue or PR** does the Vortex-side work: reproduce in unit tests, fix,
  typecheck, lint, commit, push. Give it a self-contained brief: branch, worktree, the problem
  statement, and any review findings as a file path, not pasted history. It must not start
  Vortex, touch the kit, or edit the PR description. It reports kit or doc gaps back instead of
  working around them.
- **A separate fresh agent does QA and adversarial review on each pushed PR.** It reproduces the
  problem on the base by itself, confirms the fix in the app, tries to break it, then reviews the
  diff (see PULL-REQUESTS.md). It is the only other agent that drives Vortex, and only while it
  holds the instance lease. The orchestrator sends confirmed findings back to a new fix agent,
  and the cycle repeats until QA and review find nothing blocking.

This separates using the kit to develop Vortex from improving the kit itself. The orchestrator
turns the gaps agents report into kit changes, so the next agent inherits them.

**Serialize anything that touches Vortex, and hold the lease.** Only one Vortex instance can run at a time: the
harness, E2E and `verify` share profiles, ports and `src/main/build`. The kit enforces it with a
machine-wide instance lease (harness/AGENTS.md, "The instance lease"). Give every agent its own
owner name and have it pass `--owner <name>` (or set `VORTEX_AI_OWNER`) on every command:

- `up`, `down`, `setup`, `vortex-e2e`, `ai:test` and the `ai:test:*` scripts take the lease
  themselves and refuse, naming the holder, while another owner has it.
- Wrap anything else that uses Vortex in it:
  `pnpm run ai -- lease run --owner <name> --wait 60 -- pnpm run verify`.
- For a longer session (QA across several commands), take it up front with
  `lease acquire --owner <name> --purpose "<why>" --ttl 120`, renew by acquiring again, and
  `lease release --owner <name>` at the end. `lease status` shows who has it.

A refused command changed nothing; wait (`--wait`) rather than releasing another owner's lease.
Keep a single development
checkout and run fix agents in it one after another, not in parallel worktrees. Extra worktrees
multiply native-module installs, can hit Windows path-length limits, and make it easy to drive or
verify the wrong tree. Parallelize only work that never builds or launches Vortex: code reading,
reviews, and Linear or GitHub triage.

## Implementing a feature from a design

Translate the supplied design into explicit acceptance criteria before changing
code: information hierarchy, spacing, typography, control behavior, empty/error
states, keyboard access, overflow rules, and resize behavior. Reference the
specific design page or section in the test or verification notes.

Build on Vortex's existing components and conventions from `docs/frontend.md`
and its design-system guidance. Capture the implementation at the design's
reference size and at neighboring sizes. Compare screenshots visually as well
as checking DOM/state behavior. Structural layout heuristics cannot verify
typography, icon choice, color, or fidelity to a reference image.

## Width, height, and state matrix

Resize both dimensions. A list that works at a narrow width may still hide its
footer in a short window. Run the same width at different heights to expose
vertical clipping; run the same height at different widths to expose wrapping.
Record the actual window and renderer sizes because the OS may clamp requests.

```powershell
pnpm run ai -- responsive --screenshots --viewports 1024x720,1280x720,1280x1000,1920x1080
```

Run a sweep in each relevant state, using a distinct `--label` for artifacts:

| State                             | What to verify                                   |
| --------------------------------- | ------------------------------------------------ |
| Empty list / first run            | Setup guidance and primary action remain visible |
| Populated or virtualized list     | Filtering, scrolling, selection, row actions     |
| Thousands of mods                 | `ai:test:large-library`: rendered rows, freezes  |
| Long names or localized text      | Wrapping, truncation, accessible names           |
| Selection / expanded details      | Actions stay reachable; focus remains useful     |
| Modal / stacked modal / installer | Dialog scope, scrollable body, footer actions    |
| Loading / disabled / failure      | Progress, retry, cancellation, useful errors     |
| Signed out / authenticated        | Correct setup affordances without repeated login |

For repeatable state setup, use documented Redux actions/events via
`vortex_dispatch` and verify the resulting state. Use the UI when a private
dialog callback is only reachable through controls. Avoid editing Vortex's
database or depending on a production user's mods. Put recurring scenarios in
Playwright tests with explicit fixtures and cleanup.

Layout scan findings are candidates for review, not automatic proof of a bug.
An intentional scroll container or small icon can be flagged at every size;
an issue found only at one size still needs visual confirmation. Preserve the
original window size on success and failure.

## Verification boundaries

`pnpm run ci` checks this kit without launching Vortex. `pnpm run ai:test`
launches a real app with an isolated profile and disposable sandbox game. Neither
proves an authenticated Nexus collection downloads or a purchased game launches;
those require the additional setup and explicit collection/game scenario.

When working in `.vortex-src`, follow its own verification instructions. In
particular, do not overwrite a live development renderer with a production
verification build; use its documented checks and stop/restart the development
session when appropriate. Do not commit, push, or open a PR unless asked.
