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

When reproducing upstream CI, run the failing spec from `.vortex-src/packages/e2e`
using its default hidden-window mode (`CI=1`, `VORTEX_E2E_HEADED` unset). Keep a
failing log before editing and rerun that same command afterward. Our visible
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

## Extension-level unit tests

Pure DOM logic belongs in `src/uiAutomation.test.ts` under jsdom, not in a
Playwright spec. jsdom has **no layout engine**, so stub geometry explicitly
(`getBoundingClientRect`, `getClientRects`) rather than pretending it lays
anything out — there is an `installLayoutShim` helper in that file.

Every visibility bug in [KNOWLEDGE.md](../../../KNOWLEDGE.md) has a regression
test there. Add to them rather than starting a new pattern.
