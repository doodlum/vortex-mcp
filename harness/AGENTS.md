# Vortex automation operating manual

Read this first, then the relevant skill under `.claude/skills/`. Read
[KNOWLEDGE.md](../KNOWLEDGE.md) before debugging, and
[WORKFLOWS.md](WORKFLOWS.md) for bug fixes, feature development, design references,
and testing across application states and window sizes. When developing Vortex,
**read and follow its own `AGENTS.md`, `CLAUDE.md` when present, and documentation
index and task-specific AI guidance before editing its source**.

The extension drives an unmodified released Vortex through MCP. The harness
launches isolated profiles, manages caches, drives CSS hover, captures screenshots,
and runs Playwright assertions. A Vortex source checkout is optional.

## Initial setup

Use Windows, a Node version compatible with package.json, the pinned pnpm version
(`pnpm@9.15.0`), and an installed Vortex. No purchased game or Nexus account is
needed for the sandbox tests. Git is needed to clone repositories.

From this repository:

```powershell
pnpm install --frozen-lockfile
pnpm run ai -- setup --installed --sandbox
pnpm run ai -- doctor --installed --sandbox
pnpm run ai -- snapshot
pnpm run ai:test
```

`setup` builds the extension when missing and starts an isolated Vortex. `--sandbox`
creates a disposable game directory and installs a tiny game-support extension.
It supports real local archive installation, enabling/disabling, deployment, and
purge. It cannot launch a playable game. Tests allocate their own profile and ports;
they do not stop a working automation instance. To run tests against the installed
build when a source checkout exists, set `VORTEX_AI_INSTALLED=1` in the environment.

For global UI work without a game, use `setup --installed --no-game`.
For a real game, replace `--sandbox` with `--game <id> --game-path <directory>`.
An invalid explicit path fails; it never silently falls back to a real install.
Without an explicit path, the harness can locate common games through Steam.

Use the same target/game/cache flags when starting, checking, and saving a profile.
Persist regular choices in the gitignored `harness/.env` to avoid retyping them.
Normal UI commands only need the running instance's MCP port and token.

If pnpm reports a dependency-layout mismatch or asks to remove node_modules,
check `pnpm --version` against package.json before changing the lockfile. Use the
repository's pinned package manager. `vortex-ai source` checks the Vortex
checkout's `packageManager` field and bootstraps that exact version with
`pnpm dlx` when the pnpm on `PATH` differs. A sandboxed agent may need approval to
launch subprocesses or GUI applications; that is a host permission, not an OAuth
or Vortex setup step.

## Recording a feature

`vortex-ai record --ffmpeg <executable> --seconds 15 --label zoom-demo` records
only the Vortex renderer to a WebM in the artifact directory. Drive the app from
another CLI or MCP session while it records. Durations are limited to 60 seconds.
The encoder must support MJPEG input and VP8/WebM output; Playwright's bundled
FFmpeg (`pnpm exec playwright install ffmpeg`) supports both. `startRecording`
in `harness/src/recording.ts` also supports scripted demos with an explicit stop.
The recorder repeats unchanged frames, preserving real pauses and popup timers.

For inline PR media, GitHub CLI 2.99+ supports `gh pr edit --attach <file>`.
Use Markdown image references to the same local paths in `--body-file`; the CLI
uploads them as native attachments and rewrites those references. This avoids a
media branch or browser upload. Check repository push access first. GIFs and
images must be under 10 MB. Preserve actual recording durations when converting
videos so timer demonstrations remain accurate.

## Optional Nexus setup: interact once, cache automatically

Local automation needs no account. Collections require OAuth on the tested
Vortex build. A personal API key alone can make `isLoggedIn` true while collection
downloads still fail authentication. Do not ask for an API key to run local tests,
build the extension, or install a collection when OAuth is already configured.

Before installing any mods, run:

```powershell
pnpm run ai -- setup --oauth --installed
```

The harness starts its isolated global UI. If an API key was seeded, setup clears
it in this isolated profile so Vortex exposes the Log in button. Click Log in and
complete Nexus's browser authentication, including any password, MFA, or captcha.
The command waits up to ten minutes, detects OAuth access and refresh credentials,
caches credentials locally, and checks that a fresh restore still contains them. Agents
can do the surrounding setup; the account owner completes the interactive login.
Do not put passwords, API keys, or OAuth tokens in chat or committed files.

If setup times out, the window and profile remain available. Finish login, then:

```powershell
pnpm run ai -- save-login --installed
pnpm run ai -- up --installed --no-game
pnpm run ai -- auth-status
```

`setup --oauth --no-wait` returns immediately for clients that handle the setup
conversation separately. `save-login` refuses an unsigned/API-key-only profile
and refuses to copy a profile that cannot shut down cleanly. It does not infer
successful login from a cached marker alone.

The reusable login cache is independent of the selected game and API key, and
separate for installed and source-build targets. Fresh/rebuilt game profiles
can reuse it. Vortex manages OAuth refresh; credential presence does not prove
that Nexus still accepts an account. A revoked login requires repeating this
setup phase. The extension writes `oauth-<target>.json` only in harness mode;
it updates the cache on token rotation and records logout so old snapshots
cannot silently sign back in. Blank profiles inherit credentials, not old mod
lists or game paths. Cache directories contain credentials and must remain private and
uncommitted. The default cache is gitignored.

A legacy personal API key may be stored locally as `VORTEX_AI_NEXUS_API_KEY` in
`harness/.env` if a separate workflow needs it. It is optional for this setup.

## Run and reset

```powershell
pnpm run ai -- up --installed --sandbox
pnpm run ai -- down
pnpm run ai -- up --installed --sandbox --fresh
pnpm run ai -- up --installed --sandbox --rebuild-snapshot
```

| Start   | Behavior                                                                            |
| ------- | ----------------------------------------------------------------------------------- |
| Cold    | Start a blank/cached-login profile, manage the game, quit cleanly, snapshot, launch |
| Warm    | Reopen the working profile with its existing mods and settings                      |
| Fresh   | Replace the working profile with its matching baseline snapshot                     |
| Rebuild | Recreate that baseline while retaining the independent login cache                  |

`--no-game` has its own baseline. Changing target/game/path selects a matching
snapshot; an unrelated working profile is never silently reused. Vortex writes
its own state database; the harness does not edit its storage format.

`down` waits for clean shutdown. An unresponsive instance is reported and left
intact; the harness does not blindly kill a recorded PID and then certify a
possibly unflushed profile. Close the identified harness window before retrying.
A server from another cache is not stopped just because it occupies the same port.

Use `--cache-dir <dir> --port <n> --cdp-port <n>` for another independent instance.
Keep those flags consistent across commands. Both ports must be free.

## Drive from any agent or shell

`up` prints the HTTP MCP endpoint and a client-connection example. Any MCP client
supporting Streamable HTTP can use it with the printed bearer token. Connecting
an agent is optional: every exposed tool can also be called through the CLI.

```powershell
pnpm run ai -- tools --json
pnpm run ai -- snapshot
pnpm run ai -- click --ref <ref-from-snapshot>
pnpm run ai -- fill --ref <ref-from-snapshot> --value example
pnpm run ai -- press --key Escape
pnpm run ai -- call ui_get_viewport
pnpm run ai -- call vortex_query --args-file query.json
pnpm run ai -- screenshot --label before
```

`tools --json` includes live input schemas. `call <tool> --args-file <file>` accepts
a JSON object and avoids shell-quoting problems. `--args <json>` works when the
shell preserves JSON quoting. Keep credential-bearing argument files private.

The UI loop is snapshot, act, wait, inspect. Refs are opaque and expire on the
next snapshot, renderer reload, or element removal. Never reuse a stale ref.
Virtualized rows must first be filtered or scrolled into the DOM. Check
`activeDialogs` when an action seems blocked. The harness serializes its own
snapshot/action sequences against its background dialog watchers; independent
clients still need to coordinate UI actions.

| Tool/path                                        | Use                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ui_snapshot`                                    | Rendered tree, accessible names, refs, active dialogs; selector/index scope               |
| `ui_click`, `ui_fill`                            | Mouse sequence and React-compatible input changes                                         |
| `ui_press_key`                                   | DOM keyboard handlers; not native OS dialogs or browser text insertion                    |
| `ui_select_option`                               | Native select; custom dropdowns need click-then-click                                     |
| `ui_scroll`                                      | Scroll plus events for virtualized lists                                                  |
| `ui_wait_for`                                    | Poll selector/text; inspect `matched` because timeout returns false                       |
| `ui_hover`                                       | JavaScript hover handlers only                                                            |
| harness `realHover()`                            | Real mouse over CDP, including CSS `:hover`                                               |
| harness `realWheel()`                            | Native wheel input over CDP, optionally holding Control; releases the key even on failure |
| `ui_get_viewport`, `ui_set_viewport`             | Read/resize actual window and renderer dimensions                                         |
| `ui_detect_layout_issues`, `ui_responsive_sweep` | Advisory layout findings                                                                  |
| `ui_read_console`                                | Renderer console/errors since a sequence number                                           |
| `nexus_auth_status`                              | Credential-presence booleans, never credentials                                           |
| `automation_status`                              | Isolated profile path and renderer lifetime ID                                            |
| `vortex_query`, `vortex_dispatch`                | Inspect state, invoke documented actions/events                                           |

Harness `clickByName`/`fillByName` use exact case-insensitive strings, or explicit
regular expressions for partial matches, and reject ambiguous targets. Use
accessible names, not guessed visible text. Scope modal actions to their dialog.
Native file pickers are avoided through `install <archive>` or a documented event.

## Install and deploy

```powershell
pnpm run ai -- install C:/fixtures/example.zip
pnpm run ai -- collection <collection-url>
pnpm run ai -- deploy --game <active-game-id>
pnpm run ai -- purge
```

Local archive installation waits for the installer to finish. Collection installs
check OAuth before downloading and wait for required members to finish. FOMOD
navigation accepts defaults; unexpected dialogs remain visible for diagnosis.
This cannot guarantee that every third-party installer or website download works
unattended. Add a scoped policy/helper and regression coverage when a supported
workflow needs one, rather than guessing an answer globally.

Deployment refuses while mods are installing or when installation state cannot
be read. Foreign-instance purge prompts are cancelled by default. `deploy --purge`
explicitly allows removing another instance's deployed files. Use disposable
paths for destructive test cases; changing Vortex's profile location alone does
not isolate writes to a real game's directory or game-specific configuration.

`e2e <collection-url>` additionally verifies collection completion, deployment,
and game launch. This needs the actual game and authenticated network access;
it is distinct from the account-free local sandbox suite. Do not use the sandbox
executable as evidence of a successful game launch.

## Tests, responsiveness, and development

`ai:test:nexus` is the opt-in authenticated integration test. Use the same target,
cache and ports as account setup (environment variables below apply). It stops
that harness instance, creates a separate `nexus-smoke` profile and disposable
Stardew Valley directory, installs the five required members of revision 1 of
`stardewvalley/nudx7b`, verifies deployed SHA-256 hashes, purges, and saves JSON
and screenshot evidence. It copies refreshed credentials back on clean exit.
It does not launch a game. Nexus Premium is required for unattended member
downloads; an account without it may require browser clicks for each file.
Check that prerequisite during initial account setup. Service outages are
reported as failures; they are not a reason to repeat OAuth login.

For a different collection use `e2e <url> --no-launch` with the real game ID and
an explicitly disposable game path. Omit `--no-launch` only with a playable
game. A launch check requires a newly observed game process, not one already
running before the command.

```powershell
pnpm run ci
pnpm run ai:test
pnpm run ai -- responsive --screenshots --viewports 1024x720,1280x720,1280x1000,1920x1080
```

CI runs typechecking, lint, formatting checks, unit tests, and a build. The separate
Playwright suite drives real Vortex through MCP and asserts through Playwright or
the filesystem. Say which suite ran and disclose skips. The app may make its own
background network requests even when no Nexus account is needed for the test.

For a Vortex pull request, run `pnpm run ai -- pr-checks <number-or-url>` first.
It reads the current head through the authenticated `gh` CLI and expands failed
jobs into their exact failed steps. In particular, it distinguishes a failing
test step from successful tests followed by report encryption or upload failure.
It exits nonzero while any check is pending or failed and supports
`--repo <owner/name>` and `--json` for other repositories or automation.

For an upstream E2E CI failure, first run its exact failing spec from
`.vortex-src/packages/e2e` with `CI=1`, `VORTEX_E2E_HEADED` unset, and
`pnpm exec playwright test src/tests/<spec>.spec.ts --workers=1 --retries=0`.
Save before/after logs. Do not substitute the harness's visible app for that
reproduction. Check the workflow's launch flags, credentials and actual test
summary, not just its step conclusion. Animation tests need a rendered window;
see the hidden-window entry in `KNOWLEDGE.md`. Test missing-credential skips with
the account environment variables empty, alongside a signed-out smoke test.

`pnpm run ai:test:zoom -- --signed-out` starts a separate anonymous profile on
the next MCP/CDP ports, checks the same controls without an account, and stops it.
Its cache lives under `zoom-signed-out`; it never logs out the active profile.

`pnpm run ai:test:zoom` is an opt-in feature check against an already running
source build with zoom controls. It exercises native Ctrl+wheel, the title-bar
popover, Ctrl+plus/minus/zero, the three-second popup timer, reload persistence, bounds, and multiple
window sizes. It also compares title-bar and popup screen coordinates from 50–150%
in the modern layout, then checks that legacy has no zoom controls or chrome scaling
overrides. When signed in, it also checks the profile menu's inline zoom
controls and verifies the profile button stays fixed when the magnifier appears.
It samples animation frames to check fade-in, fade-out, collapsing space, centered
positioning, and reduced-motion behavior. It also checks matching icon sizes,
outside-click dismissal, and the three-second timer when + or - reaches 100%.
It also samples every animation frame during rapid zoom changes to catch transient
movement of the title bar, icon, or popup. It restores the original zoom, layout, and window size
and saves screenshots under `harness/.artifacts`. It needs no game or account.
It is separate from the stock-compatible suite because released Vortex may not
have these controls yet. `realWheel(config, selector, deltaY, { control: true })`
is the reusable shortcut input path; `ui_scroll` changes scroll position and
does not emulate a native wheel gesture.

Run responsive checks in each relevant state, with distinct artifact labels.
Test both width and height, inspect actual sizes after OS clamping, and visually
review screenshots against any supplied design. Structural warnings are not a
substitute for design review. See the state matrix in [WORKFLOWS.md](WORKFLOWS.md).

For Vortex development, `pnpm run ai:source` prepares `.vortex-src`; `up` prefers
that managed checkout when present. `--installed` explicitly selects the released
build; `--exe <path>` and `--dev-dir <path>` select specific targets.

Use `pnpm run dev` with `pnpm run ai:watch` for extension development. The watcher
copies rebuilt output, reloads, and waits for a changed renderer lifetime before
reporting readiness. Rebuild Vortex's own renderer using its current documented
commands when editing it. Main-process changes require a full restart. Verify
live schemas with `tools --json` after changing tool registration.

## Configuration and recovery

| Variable                                   | Purpose/default                                      |
| ------------------------------------------ | ---------------------------------------------------- |
| `VORTEX_AI_EXE`                            | Installed Vortex executable, otherwise auto-detected |
| `VORTEX_AI_DEV_DIR`                        | Explicit Vortex source directory                     |
| `VORTEX_AI_INSTALLED`                      | `1` forces installed Vortex, including tests         |
| `VORTEX_AI_GAME_ID`, `VORTEX_AI_GAME_PATH` | Game and install path                                |
| `VORTEX_AI_CACHE_DIR`                      | Profiles/login cache; default `harness/.cache`       |
| `VORTEX_AI_ARTIFACT_DIR`                   | Screenshots/reports; default `harness/.artifacts`    |
| `VORTEX_MCP_PORT`, `VORTEX_AI_CDP_PORT`    | MCP/CDP; default 3701/9222                           |
| `VORTEX_MCP_TOKEN`                         | Bearer token shared by harness and MCP client        |
| `VORTEX_AI_NEXUS_API_KEY`                  | Optional legacy Nexus API key                        |
| `VORTEX_AI_HEADLESS`                       | Hide window; screenshots may be blank                |

Run `doctor` with the same setup flags when prerequisites are unclear. No UI write
tools means Vortex started without a token. HTTP 403 means a token/host/origin
mismatch. Startup errors identify the isolated `userData/vortex.log`; avoid
printing whole logs because authentication flows may log sensitive URLs.

If a running instance predates `automation_status`, update its installed extension
and restart it through its existing MCP `vortex_quit` tool before using the new
lifecycle commands. Never treat a port collision as permission to stop an unrelated
Vortex. Do not commit profiles, screenshots with private data, or credentials.
