---
name: vortex-ui-test
description: Write or debug a Playwright test for Vortex's UI in this repo, driving the app through the MCP ui_* tools and asserting via Playwright. Use when adding a regression test for a UI behaviour, testing responsive layout at multiple widths, or when an existing spec in harness/src/tests is failing.
---

# Writing a Vortex UI test

Specs live in `harness/src/tests/`. Run them with `pnpm run ai:test`.

## The shape of a test

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
- **Skip, don't fail, when the precondition is absent.** `test.skip(cond, "why")`
  — e.g. no disabled button on screen to test the disabled-click guard against.
- **Assert a direction, not an exact number,** for anything the OS clamps. A
  window resize below the minimum is clamped, so assert "moved towards" rather
  than equality.
- **Point at a disposable game directory** before running anything that deploys —
  see [harness/AGENTS.md](../../../harness/AGENTS.md).

## Extension-level unit tests

Pure DOM logic belongs in `src/uiAutomation.test.ts` under jsdom, not in a
Playwright spec. jsdom has **no layout engine**, so stub geometry explicitly
(`getBoundingClientRect`, `getClientRects`) rather than pretending it lays
anything out — there is an `installLayoutShim` helper in that file.

Every visibility bug in [KNOWLEDGE.md](../../../KNOWLEDGE.md) has a regression
test there. Add to them rather than starting a new pattern.
