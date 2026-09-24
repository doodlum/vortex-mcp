# Vortex pull requests: titles, descriptions and review

The house rules for a Vortex PR opened with this kit. The gates the PR must pass are in
[WORKFLOWS.md](WORKFLOWS.md), "Before a Vortex pull request is ready". This file covers what the PR
says and how it gets reviewed. It also records what reviews keep finding, so each round starts
from the last one's lessons.

Vortex's own `CONTRIBUTING.md` takes precedence. Keep one logical change per PR ("if the
description needs the word 'and', it's probably two PRs"). Link the issue. Say what you tested and
on which platform. Stay near **400 changed lines across 10 files** unless a maintainer has agreed
to more. The author must understand every line.

## Title

- Conventional Commits, the same form as the head commit: `fix(collections): ...` or
  `perf(ui): ...`. The scope is the area a maintainer would route it to.
- Say what changes in behaviour, in the imperative and in plain words. Don't name the mechanism.
  For example, "release the check suppression when an install completes" rather than "call
  mOnStop in close()".
- Keep it under about 72 characters, with no issue keys or trailing full stop. The issue goes in
  the body.
- If the fix changes during review, the title must still be true afterwards. Re-read it every time
  the diff changes.

## Description

Use these sections, in this order. Write for a maintainer who has not seen the report.

```markdown
## Problem

What the user sees, and in which versions. Then the root cause in two to four sentences,
naming the code. Link the issue (Linear key and/or GitHub issue) and the user report.

## Change

What each touched file now does, and why that is the smallest complete fix.

## Behaviour changes

Everything a user or extension could notice, including side effects of the fix. For example,
checks now re-run on pause, or dropdowns now position against the page. Write "None" only after
the reviewer has looked for them.

## Evidence

- **In the app (A/B):** the build, commit, `--production`, the fixture or scenario, and the harness
  command. Give a table of unpatched against patched numbers, and the number of runs.
- **Regression test:** its name, and proof that it fails without the fix (the negative control).
- **`pnpm run verify`:** the result on the exact head commit, against the master baseline. Name
  any baseline failures, and confirm the formatter left the tree clean.
- **E2E:** passed, failed and skipped counts against master. Separate regressions from
  pre-existing and credential-blocked failures.
- **CI:** state and link. Say whether any failure was infrastructure.

## Review

The adversarial review: each confirmed point and what was done about it, fixed (in which
commit) or answered (why).

## Not covered

Related problems found but left out, each with an issue link.
```

Rules for the content:

- **Every claim needs its evidence next to it.** Don't state a number, a version range or a
  mechanism you haven't checked.
- **Never write "Not run".** If a gate can't run, name exactly what blocked it.
- **No hard-coded measurements in code comments.** Numbers belong in the PR, where they can be
  dated and reproduced.
- **Update the description whenever the head moves.** Stale evidence is worse than none.

## Getting it right before review

The adversarial review should confirm a PR, not rescue it. Every real finding it makes is a
failure of the steps before it. Work in three layers, cheapest first:

1. **The author designs before coding.** Before changing code, the fix agent writes down in its
   notes, and later in the PR:
   - **Callers:** every caller of each function, component or value it will change, across `src/`
     and `extensions/`, including API exported to extensions.
   - **Exit paths:** every one through the changed code: success, early return, user Cancel,
     throw, pause and resume, re-entry.
   - **Behaviour changes:** everything a user or extension could notice. Include the other
     consumers of any value the change now passes somewhere new.
   - **The failing test:** written first, and run to confirm it fails on the base.

   Then it goes through "Review lessons" below, one item at a time, before pushing.

2. **`pr-preflight` checks it mechanically** (`pnpm run ai:preflight -- --pr <number>`; flags in
   [AGENTS.md](AGENTS.md)). It lists callers
   outside the diff's hunks (changed files included), the dispatch sites of any action whose
   reducer changed, reverts the non-test changes and confirms the tests then fail, flags
   measurements in added comments, checks size against `CONTRIBUTING.md`, and lints the PR
   description. The author runs it before pushing and puts its report in the PR. The reviewer
   gets the report too, so it does not redo mechanical work.
3. **Adversarial review and QA** by a fresh agent, which reproduces the problem and tests the fix
   in the app itself, then judges what a script can't: correctness, design and claims.

**Classify every review finding** by the layer that should have caught it:

- **preflight:** a check exists but missed it, or a check should exist. Fix or extend
  `pr-preflight`.
- **author:** covered by a lesson or by the design notes, but missed. Tighten the wording of
  that lesson or of the brief.
- **new:** no existing check or lesson could have caught it. Add a lesson, and a preflight check
  if it can be mechanised.
- **judgment:** only a reviewer could have caught it. This is the review doing its job.

Record the counts in the PR's Review section, for example "2 preflight, 1 author, 0 new, 1
judgment". The loop is working when the numbers other than judgment reach zero.

### Fix agent brief

The orchestrator sends each fix agent this brief, filled in:

```text
Fix <issue/PR url> in <checkout> on branch <branch> (from <base>). Problem: <what the user sees,
reproduction, suspected cause>. Review findings to address, if any: <path to review output>.

Read the checkout's AGENTS.md, CLAUDE.md, CODESTYLE.md, docs/testing.md and
vortex-mcp/harness/PULL-REQUESTS.md, especially "Getting it right before review" and "Review
lessons". Before changing code, write your callers, exit paths and behaviour changes list. Then
write a test that fails on the base, make the smallest complete fix, and run the scoped tests,
typecheck and lint. Run `pnpm run ai:preflight -- --checkout <checkout> --pr <number>` and resolve
everything it reports. Commit with Conventional Commits and push to origin. Never skip hooks.

Do not start Vortex (no `ai:up`, `ai:test*` or E2E), edit vortex-mcp, edit the PR description, or
use any other checkout. `ai:preflight` is allowed, because it never starts Vortex. The renderer's
vitest environment is happy-dom, not jsdom. Report: the pushed sha, your callers, exit-path and behaviour lists, the negative
control, the commands you ran and their results, the preflight report, and any kit or doc gaps.
```

## Adversarial review and QA

A fresh agent, with no part of the authoring context, reviews each pushed head **and tests it
itself**. It takes nothing at face value, including the author's reproduction, numbers and tests.
It reproduces the problem on the base, sees the fix work on the head, and tries to break the fix
in the running app. This is the only stage besides the orchestrator that drives Vortex. It must
hold the instance lease while it does, so it runs alone.

Send it this brief, filled in:

```text
QA and review Vortex PR <url> (branch <branch>, head <sha>, base <base sha>). You did not write it.
Assume it is wrong until your own testing shows otherwise. Read the checkout's AGENTS.md,
CODESTYLE.md and docs/testing.md, and vortex-mcp's harness/AGENTS.md, KNOWLEDGE.md and
harness/PULL-REQUESTS.md. Checkout: <dir>. Do not commit, push, edit the PR, or edit
vortex-mcp. Hold the instance lease for every Vortex, E2E or verify run, as owner <qa-name>:
`pnpm run ai -- lease acquire --owner <qa-name> --purpose "QA <pr>" --ttl 120 --checkout <dir>`
(the checkout lock stops anyone switching your checkout between your commands) before the first
(re-run it to renew), `--owner <qa-name>` on every kit command (`up`, `down`, `vortex-e2e`),
`pnpm run ai -- lease run --owner <qa-name> -- pnpm run verify` for verify, and
`pnpm run ai -- lease release --owner <qa-name>` when done. If a command says another owner holds
the lease, wait (`--wait 60`); never release theirs.

Test it yourself:
1. Reproduce the reported problem on the base, from the issue report: <issue/report text or
   link>. Design your own scenario rather than reusing the author's. Use the harness sandboxes
   (--sandbox, --bethesda-sandbox), never a real game or the user's Vortex profile. Build with
   --production when you take timings.
2. Check out the head and confirm the problem is gone, measured the same way. Timings need at
   least 3 runs per side, with the spread reported.
3. Try to break the fix in the app. Exercise the callers, exit paths and states around it:
   cancel, pause and resume, re-entry, other pages or components that share the changed code,
   empty or large data, and different window sizes if it affects layout.
4. Run the tests yourself, and the negative control: with the non-test changes reverted, the
   tests must fail (`pnpm run ai:preflight -- --checkout <dir>`). Run the scoped suites around the change.

Then review:
5. The whole diff, and every caller of every changed function or exported component,
   especially API exported to extensions.
6. Undisclosed behaviour changes, including values the change now passes along a different
   path.
7. Do the test fakes model the real constraint? Does the author's evidence exercise the claimed
   mechanism, or a side path that gives the same result?
8. Are the title and description accurate, complete and current for this head?
9. Every lesson in "Review lessons".

The author's callers, exit-path and behaviour lists and the pr-preflight report are at <path>.
Treat them as claims to check, not as facts.

Report:
- **QA:** the scenarios you ran and their results, unpatched against patched. Give commands,
  numbers and artifact paths (screenshots, logs, profiles). Say whether you reproduced the
  problem independently and whether the fix held.
- **Findings:** ranked blocking, medium, low, nit. Classify each as preflight, author, new or
  judgment. For each, give file:line, the concrete failure and how you confirmed it (reproduced
  in the app, ran a test, or traced the code). Say what you checked and found holding. Do not
  pad.
- **Kit gaps:** anything the harness couldn't do that you needed. The orchestrator adds it to the
  kit.
```

**Save every report the moment it arrives.** Save each fix-agent, QA and review report to a
durable file, `<scratchpad>/reviews/<pr>-round<n>.md`, and point the next brief at that file.
Agents' task output files are transcripts. They can be empty, and they are not meant to be read
back. Findings that only exist in the orchestrator's context are lost to the next agent.

**When to repeat QA.** A follow-up that changes production code gets a full QA pass again. A
follow-up that only adds or changes tests gets preflight, including its negative control, and
the scoped suites instead. The orchestrator checks that the diff really touches only test files.

**Run the slow gates last.** Run the full `pnpm run verify` and the E2E baseline only on a head
that has passed QA and review with nothing blocking. A gate run on an earlier head goes stale as
soon as the fixes land.

The orchestrator sends confirmed findings back to a fresh fix agent. It re-runs the affected
gates, then has the new head go through QA and review again, until nothing blocking remains. The
PR records each round: its Evidence section gets the QA results beside the author's, and its
Review section gets the findings and their classification.

## Review lessons

After each review, if a finding belongs to a class that could recur, add it here as a check that
authors run before pushing and that reviewers are told to apply. Give the PR where it was found.
When a lesson stops appearing because authors catch it, keep it anyway. It is the reason authors
catch it.

1. **Search every caller of a changed lifecycle path.** A shared component that gains a new
   update path changes behaviour for callers other than the one being fixed, including
   extensions. (#24281: `VisibilityProxy` re-observing broke `ConflictEditor`'s virtualisation.)
2. **List everything the change now passes somewhere new.** If you swap one value for another,
   list every consumer of that value before claiming nothing visible changes. (#24281: the scroll
   container also sets dropdown bounds.)
3. **A test must fail when the fix is reverted, including just its wiring.** Testing only a new
   helper doesn't prove anything. Run the negative control and record it. (#24281, #24282.)
4. **Fakes must enforce the real rule.** A stand-in that records calls without the constraint the
   real code applies passes broken orderings. (#24282: re-runs must be emitted after the hold is
   released.) A fake `IntersectionObserver` must report only changes, as the real one does. (visibility-proxy fix: a
   fake that re-reported on every call would have hidden the dropped-hide bug.)
5. **Release what you acquire on every exit path.** Early `return false`, a user Cancel, a throw
   and a pause. (#24282: the game-version Cancel leaked the suppression.)
6. **Evidence must exercise the claimed mechanism.** If a simpler part of the fix alone would
   produce the same result, the scenario proves only that part. (#24282: the re-run was never
   shown to matter in the app.)
7. **Qualify equivalence claims and generate adversarial inputs.** "Exactly equivalent" needs its
   domain, such as JSON-representable values. Property tests must generate `undefined`, `null`,
   nested and extra keys, arrays, and number against string. (#24283.)
8. **Check factual claims in the description, not just the code.** (#24282: "or the game is
   switched" was never true.)
9. **Report variance, not one run.** A/B numbers from a single run, or from runs under different
   harness overhead, need the number of runs and the spread. (#24283.)
10. **No measurements in code comments.** (#24284.)
11. **Make a performance fix fail without its wiring.** When the fix doesn't change behaviour, a
    "fails on the base" test is impossible. Count the work instead: wrap the input in a counting
    `Proxy` and assert reads, dispatches or calls per item, so the test fails on the base and
    with only the wiring reverted. (#24283: reads per rule 779 against 38.) A connected class
    component such as `SuperTable` can be tested without a store: mock the `ComponentEx`
    wrappers (`connect`, `extend`, `translate`) as identity functions and make `setState` commit
    synchronously. (#24284: `controls/table/calculatedValues.test.ts`.)
12. **Reviewers verify their own claims too.** Before saying a change "forces a render" or "throws",
    trace the guard that decides it. (#24284: `updateState`'s deep `_.isEqual` meant the unguarded
    copy cost O(n) but never rendered.)
13. **Check that related PRs combine.** When two open PRs touch the same code or behaviour, merge
    them without committing (`git merge --no-commit --no-ff <other>`, run the scoped suites, then
    `git merge --abort`), and say in each PR how they interact, including any conflict
    resolution. Also give new test files names that won't collide.
    (#24282 with the game-version Cancel fix: the merge was clean and the double release became a
    no-op. #24281 with #24284: both touch `Table.tsx`.)
