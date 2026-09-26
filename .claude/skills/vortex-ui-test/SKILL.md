---
name: vortex-ui-test
description: Write or debug a Playwright test for Vortex's UI in this repo, driving the app through the MCP ui_* tools and asserting via Playwright. Use when adding a regression test for a UI behaviour, testing responsive layout at multiple widths, or when an existing spec in harness/src/tests is failing.
---

# Writing a Vortex UI test

Specs live in `harness/src/tests/`. Run them with `pnpm run ai:test`. Read
`harness/AGENTS.md`, `KNOWLEDGE.md` and `harness/WORKFLOWS.md` first. Before
changing Vortex, follow its own `AGENTS.md`, docs index, and relevant frontend,
testing and design-system documentation. Extend the harness when a requested
test needs a capability that is missing; verify the workflow after adding it.

## The shape of a test

When reproducing upstream CI, run the failing spec with
`pnpm run ai -- vortex-e2e --checkout <dir> --spec src/tests/<spec>.spec.ts`: CI's
hidden-window mode (`CI=1`, `VORTEX_E2E_HEADED` unset), under the instance lease, with
the fixture's startup race patched for the run only. Keep the failing report before
editing and rerun that same command afterward (`--compare <report>`). Our visible
harness app alone does not reproduce CI's painting behavior. See `KNOWLEDGE.md`
for the hidden-window animation issue and keep login/report-secret failures
separate from feature assertions. Use real pointer and keyboard input to check
`:focus-visible`; synthetic clicks cannot establish the browser's input modality.
Start with `pnpm run ai -- pr-checks <pr>`: it expands failed GitHub jobs and
separates test failures from report encryption/upload failures.

Drive through **MCP**, assert through **Playwright**. That separation is the
whole point: asserting an MCP tool's effect with the same MCP tools would pass
even if both sides were wrong together.

```ts
import { expect, test } from "./fixtures";
import { clickByName } from "../uiDriver";

test("a click through MCP changes what Playwright sees", async ({ mcp, vortexWindow }) => {
  await clickByName(mcp, { role: "button", name: "Settings" });
  await expect(vortexWindow.getByRole("heading", { name: /settings/i }).first()).toBeVisible();
});
```

## Fixtures

All worker-scoped — launching Vortex costs minutes, and no test needs a pristine
app per assertion.

| Fixture        | What it is                                                  |
| -------------- | ----------------------------------------------------------- |
| `config`       | Resolved `HarnessConfig`                                    |
| `mcp`          | MCP client; ready only after the extension registered       |
| `vortexWindow` | Playwright `Page` for the renderer — the independent oracle |
| `vortexApp`    | `ElectronApplication`                                       |
| `managedGame`  | The configured game, managed and active                     |

## Rules

- **Never assert on a `ref` across snapshots.** They are generation-scoped.
- **Prefer `findNodes` over hardcoded selectors.** Vortex's class names are
  largely generated; labels move between versions (`Manage` → `Add game`).
- **Create deterministic preconditions.** A disabled-click test supplies a
  disabled fixture; a game test uses the sandbox game. Do not silently skip
  acceptance criteria. Report unavoidable external blockers separately.
- **Test width and height independently**, then exercise relevant loading,
  empty, populated, error, modal, filter and selection states. Structural layout
  scans are advisory; independently inspect screenshots and asserted behavior.
- **Use distinct ports and cache roots** when a test starts another instance.
- **Assert a direction, not an exact number,** for anything the OS clamps. A
  window resize below the minimum is clamped, so assert "moved towards" rather
  than equality.
- **Point at a disposable game directory** before running anything that deploys —
  see [harness/AGENTS.md](../../../harness/AGENTS.md).
- For wheel shortcuts use harness `realWheel()` over CDP, with `control: true`
  for Ctrl+wheel. It releases Control in a finally block. `ui_scroll` does not
  exercise native wheel or browser zoom behavior. The opt-in `ai:test:zoom`
  script checks applied scaling and UI behavior, including every rendered frame
  during rapid zoom changes. Run it with `--signed-out` for an isolated anonymous
  profile. `vortex-ai record --ffmpeg <path> --seconds 15 --label demo` captures
  real-time WebM clips while another MCP/CLI session drives the app.

## Panel-system regression

Use `pnpm run ai:test:panels` against a running Bethesda sandbox for panel
creation, four-panel layouts, resizing, content focus, Home scoping and
persistence. It replaces the split-view trials. Run `--verify-saved`
after stopping and reopening the same sandbox to verify disk persistence.
Match `VORTEX_AI_OWNER` to the instance owner.

Use `clickByName(mcp, query, { selector, index? })` for panel-local controls so
large tables in other panels cannot exhaust the snapshot node budget. Modern
pages use a Close control in their header; older pages and the empty chooser
use a fallback action row. Check the visible placement dropdown and adaptive
icon. New panels show sidebar-row choices and exclude pages already open.
On Home, compare choices with the Home sidebar; game-only pages must not appear.
Home and each game retain separate layouts when switching contexts.
After dragging a divider, check that the add-panel icon's cell widths change
with the workspace. The default candidate depends on wide versus tall geometry.
Sidebar navigation should focus an already-open page or replace the page
in the active panel when it is not open, even if another panel is larger.
One layout persists per game. Every open panel page has the selected sidebar
background. Only the focused panel's page carries the outline and
`aria-current="page"`; check both expanded and collapsed sidebars.
Verify panel activation when clicking actual page content
or focusing its inputs. Pop-outs
have been removed; no panel window action should be available.

## Extension-level unit tests

Pure DOM logic belongs in `src/uiAutomation.test.ts` under jsdom, not in a
Playwright spec. jsdom has **no layout engine**, so stub geometry explicitly
(`getBoundingClientRect`, `getClientRects`) rather than pretending it lays
anything out — there is an `installLayoutShim` helper in that file.

Every visibility bug in [KNOWLEDGE.md](../../../KNOWLEDGE.md) has a regression
test there. Add to them rather than starting a new pattern.
