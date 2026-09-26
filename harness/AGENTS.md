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
they do not stop a working automation instance, but they hold the instance lease (see
"The instance lease" below). To run tests against the installed
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
cannot silently sign back in. Only a real logout (Log out, or Nexus refusing
the session) writes that `null` tombstone. Stock Vortex's startup migration
`forceLogoutForOauth_1_9` also clears the login on a source build's second
launch (the build reports version 1.0.0); the extension marks that migration
applied in harness profiles and, if a forced logout still happens, re-applies
the cached credentials instead of tombstoning. Blank profiles inherit credentials, not old mod
lists or game paths. Cache directories contain credentials and must remain private and
uncommitted. The default cache is gitignored.

A new `--cache-dir` (or `VORTEX_AI_CACHE_DIR`) starts without a login. Reuse the
machine's existing one instead of logging in again or copying files by hand:

```powershell
pnpm run ai -- login-import --cache-dir D:\other-cache           # from harness/.cache
pnpm run ai -- login-import --cache-dir D:\other-cache --from D:\bench-cache
```

Target flags (`--installed`, `--dev-dir`) choose which target's login is copied,
exactly as for `up`. It refuses a logged-out source, and refuses to replace an
existing login without `--force`. Refresh tokens rotate, so the two caches
diverge afterwards; if one is refused by Nexus, import again from the other or
repeat `setup --oauth`.

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

`--sandbox` and `--bethesda-sandbox` runs are local-only, so they do **not** seed the
`harness/.env` API key (`up` says so). With a key, Vortex looks every locally installed
archive up on Nexus, and for a fixture archive that lookup only ends at its 60 s timeout, so
each install looks hung. `--with-api-key` seeds it anyway. The key is part of the snapshot key,
so the first start after changing this is cold; pass the same choice to every command. Without
the key in use, `VORTEX_AI_NEXUS_API_KEY` and `NEXUS_API_KEY` are also left out of the
environment Vortex is launched with.

`up` returns as soon as Vortex answers: Vortex runs detached with none of the caller's stdio
(stdin ignored, its stdout and stderr in `<cache>/live/vortex-stdio.log`), so a shell capturing
`up`'s output (`*>`, `| Select-String`, an agent's tool) is not held open until Vortex exits.
Its own log is still `userData/vortex.log`.

`down` waits for clean shutdown. An unresponsive instance is reported and left
intact; the harness does not blindly kill a recorded PID and then certify a
possibly unflushed profile. Close the identified harness window before retrying.
A server from another cache is not stopped just because it occupies the same port.

Use `--cache-dir <dir> --port <n> --cdp-port <n>` for another independent instance.
Keep those flags consistent across commands. Both ports must be free.

## The instance lease: one agent drives Vortex at a time

Only one harness Vortex runs per machine, and several agents may use this kit. A
machine-wide lease (`~/.vortex-ai/leases`, shared by every kit checkout; override with
`VORTEX_AI_LEASE_DIR`) says who has it. The owner is `--owner <name>`, else
`VORTEX_AI_OWNER`, else `anonymous`. Use one owner name for a whole session.

```powershell
pnpm run ai -- lease status                       # who holds what, live or stale
pnpm run ai -- lease acquire --owner qa --purpose "PR 24290 QA" --ttl 120 --checkout C:\dev\vx-ab
pnpm run ai -- up --owner qa --sandbox            # joins qa's lease
pnpm run ai -- down --owner qa
pnpm run ai -- lease release --owner qa           # everything qa holds, instance and checkouts
pnpm run ai -- lease run --owner qa --wait 60 -- pnpm run verify
```

- Everything that starts or stops Vortex holds it: `up`, `bootstrap`, `setup`,
  `save-login`, `down`, `e2e`, `vortex-e2e`, `ai:test` (for the whole run, from its global
  setup) and the `ai:test:*` scripts, which refuse to drive an instance another owner holds.
  Free or stale: taken implicitly for the command. Same owner: joined. Another live owner:
  refused before anything is stopped, with the holder, its purpose and how to wait or
  release.
- `up` leaves the lease held by the running Vortex, so it lasts until `down` (or until that
  Vortex exits). A command's implicit lease ends with the command.
- `lease acquire` takes an explicit lease that lasts `--ttl` minutes (default 60; `0` for
  none) or, with `--pid <n>`, while that process runs. Acquiring again renews it; that is
  the heartbeat. `up`/`down` inside it leave it held.
- `lease acquire --checkout <dir>` takes the instance lease **and** that checkout's lock, all
  or nothing: when either is refused, whatever the call newly took is given back. It takes
  the instance first, so a refused caller has touched nothing. `--checkout-only` takes just
  the checkout (a fix agent that never starts Vortex).
- `lease release --owner <name>` releases **every** lease that owner holds, the instance and
  each checkout, in one call. `--checkout <dir>` releases only that checkout. A checkout a
  Vortex still runs from stays locked by that Vortex either way (`down` ends it).
- `lease run [flags] [--] <command...>` holds the lease while the command runs, passes
  `VORTEX_AI_OWNER` to it (so kit commands inside join rather than refuse), releases it
  however the command ends, and exits with its code. Flags go before the command; the
  command starts at its first word, because Windows PowerShell 5.1 strips `--`. Use it for
  `pnpm run verify` and anything else that touches Vortex without the kit launching it.
- `--wait <minutes>` on `lease run` and `lease acquire` polls until the holder is done.
- A lease is stale when every process holding it has exited, or when an explicit lease's
  TTL passed; the next acquirer reclaims it and says so. Reclaiming a TTL-expired lease
  whose Vortex still runs means that Vortex gets stopped by the next `up` or `down`.
- `lease release --force` (no `--owner`) clears the instance lease whoever holds it;
  `--owner <name> --force` clears all of that owner's. Only a human should, after checking
  its holder is really gone.
- Commands that rewrite a Vortex checkout also lock it (`checkout:<path>`): the
  `pr-preflight` revert check and `vortex-e2e`'s fixture patch. `lease run --checkout <dir>`
  and `lease acquire --checkout <dir>` take the same lock.
- Running Vortex from a checkout locks it too. A launch with `--dev-dir <dir>` (or the managed
  `.vortex-src`) takes or joins `checkout:<dir>` besides `instance`, and its Vortex holds both
  until it exits, so nobody rebuilds or switches the checkout under it; a holder of the checkout
  lock who starts Vortex takes `instance` too. `script` and the `ai:test:*` checks, which drive
  a running instance, take the checkout it was launched from (recorded in
  `<cache>/instance.json`). Releasing your explicit checkout lease while your Vortex still runs
  from it leaves it held by that Vortex (`down` ends it).

Limits: liveness is a PID check, so a reused PID can keep a dead holder's lease looking
live until `lease status` shows it and its owner releases it. The lease serializes kit
users; it does not stop a process that ignores it.

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
a JSON object and avoids shell-quoting problems (a byte-order mark from PowerShell is fine).
`--args <json>` works when the shell preserves JSON quoting. Keep credential-bearing argument
files private.

### Scratch scripts and renderer diagnostics

`vortex-ai script <file.mts> [its args...]` runs a scratch script with the kit's tsx, holding
the instance lease, with the command's instance settings in the environment (cache dir, ports,
token). `--owner <name>` and `--wait <minutes>` are the kit's wherever they appear, before or
after the file; every other argument after the file goes to the script, and everything after a
bare `--` does too, `--owner` included. It prints the owner it runs as. Outside this repo:

- name it `.mts`: tsx treats a `.ts` file with no ESM `package.json` above it as CommonJS,
  where top-level `await` fails;
- import the kit by `file://` URL, because on Windows `C:\…` in an import is read as a URL
  scheme, and bare names (`fflate`) do not resolve from outside the repo. One import gives
  everything: `harness/src/kit.ts` re-exports the harness modules and the zip helpers, and
  `script` puts its URL in `VORTEX_AI_KIT`:

```ts
const kit: typeof import("file:///C:/dev/vortex-mcp/harness/src/kit.ts") = await import(
  process.env.VORTEX_AI_KIT!
);
const mcp = kit.clientFor(kit.loadConfig());
```

A script that proves useful becomes a harness module with a test, not a file passed around.

`page.evaluate(() => { … })` with named inner functions works from a script:
`attachToRenderer` defines esbuild's `__name` helper in the page (`NAME_SHIM` in `cdp.ts`),
because tsx compiles every file with `keepNames`, hard-coded, and the page otherwise throws
"`__name` is not defined". Kit modules still send page code as source text, which needs no
shim and also runs in the unit tests' jsdom.

`vortex-ai eval --expr "<expression>"` (or `eval <file.js>`) evaluates JavaScript in a harness
instance's renderer over CDP and prints the result as JSON; a promise is awaited, so use an
async IIFE for statements. It is for diagnostics: a component's props, a computed style, what a
private object holds. It refuses unless the MCP server reports a profile inside this cache and
the renderer reached over CDP reports the same one, so it never touches the operator's Vortex.
Anything a test or workflow relies on belongs in an extension tool or harness helper instead.

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
| `automation_status`                              | Profile path, renderer lifetime ID, NODE_ENV and the React build loaded (`react.build`)   |
| `collection_install_state`                       | Collection InstallDriver step, install session and collection dialogs (see below)         |
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
pnpm run ai -- responsive --screenshots --viewports "1024x720,1280x720,1280x1000,1920x1080"
```

In PowerShell, quote the viewport list (`--viewports "1024x720,1280x720"`): unquoted, `a,b` is
an array, and through pnpm's `pnpm.ps1` shim it arrives as one argument with a space
(`"1024x720 1280x720"`). `responsive` accepts that too, but quote it anyway, and quote any
other comma-separated value.

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

Before pushing a Vortex branch, run `pnpm run ai:preflight` (the same as
`pnpm run ai -- pr-preflight`) and put its report in the PR. It works on any Vortex
checkout (default `.vortex-src`, or `--checkout <dir>`) and diffs the committed
`HEAD` against its merge-base with `--base` (default `upstream/master`). Each check
prints PASS, WARN, FAIL or SKIP with file:line detail; it exits 1 on any FAIL.

| Check                    | Result                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size                     | WARN above 400 changed lines or 10 files (Vortex `CONTRIBUTING.md`), ignoring lockfiles, `etc/*.api.md`, snapshots and build output                                                                                             |
| Callers outside the diff | WARN, as a to-review list: hits in `src/` and `extensions/`, outside the diff, for each exported or class-member declaration the diff touches. Test hits are listed separately; comment-only hits and generic names are skipped |
| Readers of changed state | WARN: for each class field whose assignment the diff adds or removes (`this.mStep = …`), the other lines of the file that read it, by member, and the uses outside the diff of any getter that exposes it (`driver.step`)       |
| Dispatchers of reducers  | WARN: for each reducer handler the diff changes (`[actions.addModRule as any]: (state, payload) => …`), its action creator and every call of it, extensions included, plus lines using its type string (`"ADD_MOD_RULE"`)       |
| Revert check             | FAIL unless the tests pass on the branch and fail with every non-test changed file restored to the base                                                                                                                         |
| Measurements in comments | WARN for timing or size figures in added comments                                                                                                                                                                               |
| PR description           | With `--pr <number-or-url>`: FAIL for a non-Conventional or over-72-character title, a missing section, "Not run", or no head sha in the body                                                                                   |

How callers are found:

- "Outside the diff" means outside its hunks, not outside its files: a call on an unchanged
  line of a changed file counts, and the report says how many hits are in changed files. The
  symbol's own declaration line is left out.
- An exported function, component or type: `git grep -w` for its name.
- A class member: only **member uses**, `x.name`, `this.name`, `x?.name`, or a JSX attribute
  `name={…}`. Bare words are locals and imports. A file that declares its own member of that
  name belongs to another class, so its declaration and `this.name` uses are left out; in the
  member's own file `this.name` counts. The report says how many hits were left out. A member of
  a class nothing outside the diff reaches is still searched in its own file.
- The class or component itself. Every consumer of it can notice a change to any member, so
  the report lists them: references by name and, when it is the file's default export
  (`export default translate(…)(SuperTable)`), every module importing that default, including
  `@/` aliases. A barrel that re-exports it (`controls/api.ts`, `util/api.ts`) is followed to
  the files importing that name from the barrel or from `@nexusmods/vortex-api`, and for
  `util`-style barrels to `util.name` uses.

Test code is `*.test.*`, `*.spec.*` and anything under `__tests__`, `__mocks__`, `__fixtures__`
or `test-utils` (Vortex's `src/renderer/src/test-utils/` builders and harnesses): never reverted,
never counted as a production caller. A changed **private** function (an unexported top-level
function or constant, such as `testRef` in testModReference.ts) is followed one level: the
exported functions and class members of the same file that call it are listed as
`name [function] via private testRef`, with their callers.

The revert check runs `pnpm exec vitest run` on `--test <path>` (repeatable), or on the
test files the diff adds or changes, in each test's nearest `package.json` directory
(`--project-dir <dir>` overrides). A `--test` path may be absolute, relative to the checkout
root, or relative to `--project-dir`; the first that exists is used, and one that exists in
neither place fails the check. vitest is then given paths relative to the directory it runs
in, which the report states. `--revert <path>` (repeatable) reverts only those
files, which is how to show a test fails when just the wiring is reverted. `--revert-hunk
<file>:<line>` (repeatable) reverts only the hunk of that file holding that head-side line (for
a deletion, the line before or after it), from `git diff -U0`: a call site in a file that also
defines the new code, which a whole-file revert would turn into a missing export. A line no
hunk covers fails the check, listing the hunks. Without `--revert`, only the named hunks are
reverted. It is the only
check that writes to the checkout. It refuses on uncommitted changes, keeps a backup in
the temp directory, restores the branch's exact bytes on success, failure, throw and
Ctrl+C, and then checks hashes and `git status`. `--skip-revert` skips it.
`--head <ref>` checks a ref without checking it out, for example someone else's
branch; the revert check is then skipped. `--json` prints the full report, including
every caller hit.

Limits: symbols come from a regex and indentation heuristic over the declarations
enclosing each changed line (see `touchedSymbols` in `prPreflight.ts`). Imports are
parsed with a regex too (`parseImports`). Object-literal methods, callers that use a
different name, and `require()` imports are missed. A subclass using an inherited member
as `this.name` is left out when it also declares a member of that name. A member of a
class nothing outside the diff reaches (by name, import or barrel) is not searched. Member
uses match any object with a member of that name (`props.step` for a `step` getter), so the
list still needs reading. State readers are found only in the field's own file. A test that
fails after the revert only because a new export is missing gets a WARN, not a PASS.

### Vortex's own E2E suite

`pnpm run ai:vortex-e2e -- --checkout <dir>` (the same as `pnpm run ai -- vortex-e2e`)
runs `<checkout>/packages/e2e` the way upstream CI does: `CI=1`, `VORTEX_E2E_HEADED`
unset, `playwright test --workers=1 --retries=0 --reporter=list,json`. It needs a
built checkout (`pnpm run build` there) and holds the instance lease and the
checkout's lock. Stock, that suite gives no usable local result (see KNOWLEDGE.md), so
for the run only it:

- applies the kit's fixture patches from `harness/patches/`
  (`e2e-window-startup.patch`: the main-window startup race in
  `packages/e2e/src/fixtures/vortex-app.ts`). It refuses when those files have
  uncommitted changes, fails without guessing when `git apply --check` does, skips a
  patch the checkout already contains, and restores the exact bytes afterwards (also on
  a throw or Ctrl+C), then checks hashes and `git status`;
- leaves out, with `--grep-invert`, the tests that need a Nexus test account whose
  credentials (`E2E_NEXUS_FREE_USER_*`, `E2E_NEXUS_PREMIUM_USER_*`, from the environment or
  `packages/e2e/.env`) are absent. They are found from each describe's
  `test.use({ nexusUser })` and `freeUser`/`premiumUser` in a test's body, and reported
  as "skipped for missing credentials", not as failures. It lists the tests again with the
  filter and refuses to run if the count differs from what it computed.

| Flag                      | Effect                                                              |
| ------------------------- | ------------------------------------------------------------------- |
| `--checkout <dir>`        | Vortex checkout (default `.vortex-src`)                             |
| `--spec <file>`           | Relative to `packages/e2e` or `packages/e2e/src/tests`; repeatable  |
| `--grep`, `--grep-invert` | Passed to Playwright (the credential filter is added to the latter) |
| `--compare <report.json>` | Diff against an earlier run: regressions, pre-existing, fixed       |
| `--json`                  | Print the report as JSON; Playwright's own output goes to stderr    |
| `--owner <name>`          | Lease owner                                                         |

It prints passed, failed, skipped and credential-skipped counts, each failure with its
error's first line, the duration, the checkout's HEAD sha and whether the patches were
applied and restored. The JSON report goes to
`harness/.artifacts/vortex-e2e/<time>-<sha>.json`, with Playwright's raw report beside it.
The exit code is 1 on any failure, or with `--compare` on any regression (failing now,
not failing in the baseline), and on a failed restore. For a PR, run master into a
baseline report first, then the branch with `--compare <baseline>`.

For an upstream E2E CI failure, first run its exact failing spec with
`vortex-e2e --spec src/tests/<spec>.spec.ts`. Save before/after reports. Do not
substitute the harness's visible app for that reproduction. Check the workflow's launch flags, credentials and actual test
summary, not just its step conclusion. Animation tests need a rendered window;
see the hidden-window entry in `KNOWLEDGE.md`. Test missing-credential skips with
the account environment variables empty, alongside a signed-out smoke test.

### A Bethesda game without the game

`up --dev-dir <checkout> --bethesda-sandbox` manages a fake Fallout 4 that Vortex's own
Fallout 4 support accepts. It gets plugins, LOOT, the Plugins page and the Missing Masters
check, with no game installed. It is made of:

- a stand-in `Fallout4.exe` and a `Fallout4.esm`;
- plugins generated by `pluginBytes`/`writePlugin` in `bethesdaSandbox.ts`, with real TES4
  headers so masters parse;
- private `LocalAppData` (plugins.txt, loadorder.txt) and `Documents\My Games\Fallout4`
  (INI files and backups) under the cache.

Vortex is started with `LOCALAPPDATA` pointing at the private copy, and Documents moved by
a `NODE_OPTIONS=--require` preload (`mainPreload.ts`).

The harness refuses to manage the game unless `automation_status.paths` shows both
redirects took, so the operator's real Fallout 4 profile is never written.

**Source builds only:** packaged Vortex ignores NODE_OPTIONS, and the harness then stops
Vortex before a game can activate. For a released version's behaviour, build that release
tag from source.

`--isolate-user-folders` gives any game the same private folders.

### Offline collections

`offlineCollection.ts` builds collection archives whose members are bundled inside them, and
installs them with no Nexus or account:

- **Manifest.** Members can be `optional` (a `recommends` rule). The manifest lists the members'
  plugins (`plugins: [{ name, enabled }]`, by default every root `.esp/.esm/.esl`, enabled), as
  Vortex's exporter does for Bethesda games. Without that list the gamebryo collection parser
  throws and postprocessing stops before plugin enabling (KNOWLEDGE.md).
- **Install from a download.** `addOfflineCollection` copies the archive into the game's
  download folder, registers it with `addLocalDownload` and installs it with
  `start-install-download`, as Vortex does with a downloaded collection. The collection mod then
  has an `archiveId`, so revision information is read from the download. `via: "file"` keeps the
  old `start-install <path>`, which leaves `archiveId` null.
- **The game-version prompt.** `gameVersions: [MISMATCHED_GAME_VERSION]` stamps
  `nexus.ids.revisionId` and `nexus.revisionInfo.gameVersions` on that download
  (`setRevisionInfo`). The driver then shows "Game version mismatch" at Install Now.
  `answerGameVersionPrompt(mcp, "continue" | "cancel")` answers it, or
  `installOfflineCollection(…, { gameVersions, gameVersionAnswer })` does it for you. This is for
  that prompt only: with a revision id set, the driver also records a pending vote for it.
- **`installOfflineCollection`** drives Install Now → prompt → review and closes the review. It
  skips optional members (No Thanks) or, with `optionals: "install"`, clicks Install optional mods
  first; `optionals: "stand-in"` clicks it and then completes that pass without installing
  (below). It fails at once on an "incomplete" review unless `allowIncomplete`. It returns
  `closedWith` (the button) and `postprocessed`: whether `collection-postprocess-complete` fired
  for this collection, seen through the extension's `onEvent` listener. `onPhase(name, detail)`
  is called at install-now, game-version-answered, review-shown (again after an optionals pass),
  optionals-install, optionals-stand-in, review-closing and review-closed, for timestamps.
- **Dialogs are found by their own text and buttons, never a full snapshot.** Install Now is
  waited for with `ui_active_dialogs` (`waitForInstallNow`) and clicked inside its dialog. With a
  few hundred mods on the Mods page a full snapshot reaches its node limit before the modal, so
  its buttons are not in it; and a dialog's text is cut at 400 characters, before the buttons of
  a review with a description. `dialogButtons(mcp, dialogText)` (`uiDriver.ts`) lists a
  dialog's buttons with disabled ones marked: a button disabled while the review postprocesses
  is not an absent one.

- **Rules and references.** `modRules` on the collection writes inter-member rules; a member's
  `fileExpression` overrides its bundle name (a glob, for an already-installed member matched by
  tag).
- **Updating to a new revision.** `updateOfflineCollection(mcp, oldCollectionModId, archive,
{ remove, keep })` does what Vortex's `collectionUpdate` does once the new revision is
  downloaded: marks `keep` members as installed individually, removes the old collection mod
  (and `remove`) with `remove-mods` and reason `collection_update`, keeping the other members,
  then installs the new revision from its download. It returns `removeMs` and the install
  result. Not reproduced: the changelog, the "Remove mods from old revision?" question (pass its
  answer), and re-enabling optional members.
- **Clicking inside a dialog.** `clickInsideDialog` throws when it clicks nothing (listing each
  dialog container and its buttons) or when `ui_click` reports clicking something other than the
  button; pollers pass `{ required: false }` and get undefined. It identifies the container by the
  scoped snapshot's `rootText`.

Bundled optional members that are then installed have stalled until Vortex's stall watchdog
fired (5 min) in QA. That is not diagnosed yet; the default skips them. To test what happens
around an optionals pass (the review leaving and coming back, its fade, its lists) without that
install, `completeOptionalsWithoutInstall(mcp, collectionModId)` stands in for it after Install
optional mods was clicked: it adds an installed, enabled mod carrying each missing optional
rule's tag, marks the session's optional entries installed (`COLLECTION_UPDATE_MOD_STATUS`) and
emits `did-install-dependencies` with recommendations true. InstallDriver then returns to the
review by itself (108 ms in the app). No member's files exist: never use it to test the install.

- **Resuming offline.** `resumeViaNotification(mcp, collectionModId)` is the only path to
  `InstallDriver.start` that works without a login (`resume-collection` and the Premium restart
  need one; Install Now goes through `query`). After Later at Install Now, it enables the
  collection mod and deploys, so the dependency check reports the unfulfilled rules and Vortex
  raises "Collection incomplete", then clicks that notification's Resume: a `.notification`
  toast in the classic layout, an entry of the title bar's Notifications popover in the modern
  one (it opens it). Vortex raises that notification once per collection per session, so a
  second resume of the same collection needs a restart; it deploys, so sandboxes only.
- `reviewDialogsFor(mcp, collectionModId)` counts the open review screens
  `collection_install_state` attributes to that collection.

**A deterministic load order.** After a deploy Vortex orders plugins as their files were found,
which differs between runs, so the Plugins page's displayed values could not be compared across
builds. `setDeterministicLoadOrder(mcp)` (`bethesdaSandbox.ts`) turns LOOT's autosort off and
applies `deterministicLoadOrder`: the game's natives first, then masters, light plugins and
plugins, each by name (`SET_PLUGIN_ORDER`, enabled states kept), and checks that
`state.loadOrder` reads back in that order. Two fresh runs gave the same 151-plugin order.

`pnpm run ai:test:bethesda` checks Missing Masters on the fake game: a plugin with an absent
master must be flagged and reported, before and after a completed offline collection.
Releases up to master of September 2026 fail the second half (Nexus-Mods/Vortex#24282). On the
way it checks the collection's finalize path: `collection-postprocess-complete` fired, and the
manifest's plugin list was applied (Alpha enabled, Beta disabled). A third scenario installs a
collection whose revision excludes the installed game version: the prompt must appear and
Continue must complete the install.

### Where a collection install is

Vortex does not expose its collection `InstallDriver`; `registerAPI` only offers the install
session. `collection_install_state` (read tool) reports:

- `driver`: `step` (`prepare`, `changelog`, `query` = Install Now shown, `start` = continues on
  the next update, or with the game-version-cancel fix, once the game-version prompt is
  answered, `disclaimer`, `installing`, `review`), `installDone`, `postprocessing`, the
  collection id and name. It is read from the `driver` prop Vortex passes its always-mounted
  collection dialogs, by walking React's fiber tree. That is a private shape. When a build stops
  passing the prop, `driver.found` is false with the reason.
- `session`: `state.session.collections.activeSession` summarised, with members by status and
  type and the ones outstanding.
- `driver.preparing`: work queued with `driver.prepare()` is unfinished (`start` and `query`
  wait for it); from the private Bluebird chain, null when not observable. `driver.starting`: a
  start attempt is in progress (the revision fetch, the game-version prompt), from the private
  `mStarting` token that only builds with the game-version Cancel fix have; null elsewhere.
  `driver.lastCollectionId`: what the review shows after the install ended.
- `dialogs`: the open modals, tagged with their step (`query`, `game-version-prompt`,
  `review`) and the collection each belongs to: `collectionId`, `collectionName` and `via`, which
  is `driver` (the rendering component's `driver` prop), `collection-prop`, or `text` (a
  `showDialog` prompt naming an installed collection); null when nothing says.

`vortex-ai call collection_install_state` from a shell. It is cheap enough to poll.

To wait on a plain Vortex event (`events.emit`, which `onAsync` never sees), use
`vortex_dispatch` with `action: "onEvent", args: ["<event>", "__CALLBACK__"]`, then
`poll_listener`. There is one listener per event name: registering it again returns the same
`listenerId`, so read from a `lastSeq` you took first (`watchEvent` in `offlineCollection.ts`
does).

### Measuring renderer, main process and checks

- **`perf_trace_start` / `perf_trace_stop`** (extension, write tier) wrap the store's
  dispatch. For each action type they give count, total ms and max ms. They also report
  every main-thread task over 50ms and heap start/max/end. A dispatch's time covers
  middleware, persistence diffing, reducers and subscribers; React rendering shows up as
  long tasks.
- **`profileRenderer(page, run)`** (`profiling.ts`) takes a CDP CPU profile of the
  renderer. It summarises self time by function and by source file, inclusive time (a function
  and everything it called, once per sample: `inclusive`, and `inclusiveApp` without
  dependencies, native frames or this kit's extension), and the longest stretch without idle
  (`longestBusy`, with what it spent it on). It saves a `.cpuprofile` that DevTools opens, and
  returns the raw `profile` and `pageStartMs`, the page's clock at the profiler's start: a time
  the page records later minus that is its offset in the profile. `summariseWindows(profile,
windowsFromMarks(marks, durationMs))` summarises the stretches between marks.
- **Table and dialog probes** (`tableProbes.ts`), for any SuperTable and any modal:
  - `measureRowIdentity(page, action, condition, { tables })`: per table, how many rows the
    action gave a new data object (`changedRefs`), how many of those hold no different value
    (`spurious`), which columns differed (`keyHist`), how many TableRows got a new `data` prop and
    how many re-rendered (`rowRenders`). It wraps each SuperTable's `updateState` and TableRow's
    prototype, found through the fiber tree, and removes them afterwards. An in-place mutation
    of an existing row object is invisible to it.
  - `measureAfter(page, action, condition)`: blocked time and the longest task until
    `condition`, a page expression, first holds (checked on every DOM mutation and every 50 ms),
    rather than until idle; `untilCondition` and `total` (with an `afterMs` tail). It throws when
    the condition already holds before the action.
  - `recordDialogFade(page, { selector, text }, run)`: the dialog's class, title, text and
    buttons (disabled marked) on every mutation while `run` closes or changes it, until it has
    been unchanged for `settleMs`; `gone` says whether it left the DOM.
- **`markLog` / `readSince` / `summariseLog`** (`vortexLog.ts`) read Vortex's own log for
  the span of an operation. They cover persist:diff counts per hive, `level_pivot slow
Write`, mod sort timings, state backups, memory warnings and renderer crashes. That is
  the main-process evidence available without changing Vortex.
- **`check_probe_counts`** reports how often Vortex ran its health checks per test event.
  It is counted by no-op probe checks registered through `registerTest`, in harness
  instances only. A count that stops rising while its event fires means that event's
  checks are suppressed.

**Build for production with the kit.** `pnpm run ai -- build --checkout <dir> --production`
runs the checkout's `pnpm run build` with its pinned pnpm (`pnpm dlx pnpm@<packageManager>` when
the pnpm on PATH differs, parent `npm_*`/`PNPM_*` variables stripped), with NODE_ENV=production
in the build's own environment only (without `--production`, NODE_ENV is removed from it). It
holds the checkout's lock, refuses while a Vortex runs from the checkout, puts back
`etc/vortex.api.md` and `etc/Dependency Report.md` when the build rewrote them, and reports the
bundle mode afterwards. The caller's environment is never touched, which matters because the
agent sandbox blocks `Remove-Item Env:NODE_ENV`; to clear a variable by hand there, use
`$env:NODE_ENV=$null`.

**Measure in production mode.** A source build normally runs with NODE_ENV=development,
which loads React's development build, several times slower at rendering. Use
`up --dev-dir <checkout> --production ...` for any timing that should stand for what
users see. It launches with NODE_ENV=production and then checks the renderer: `up` stops
Vortex and fails unless `automation_status` shows `nodeEnv: "production"` and
`react.build: "production"` (react and react-dom loaded `react*.production*.js`). It warns when
the checkout is a development bundle (a plain `pnpm run build`): React is then production, but
Vortex's own development-only branches, inlined at build time, still run. For full release
parity build it with `build --checkout <dir> --production` (above; nx caches the two modes
separately). Released builds are always in production. Compare A/B builds in the
same mode, from the same `--fresh` baseline, and record `automation_status.react` with the
numbers.

**Keep the observer light.** Poll dialogs with `ui_active_dialogs` (or `openDialogs` in
`uiDriver.ts`), not full `ui_snapshot`s. A full snapshot measures every rendered element.
With thousands of mods rendered, one per second costs seconds of renderer time and becomes
the top entry in the profile being taken. The harness's dialog watcher and collection
driver already poll this way.

More opt-in performance checks. Each writes JSON evidence (and, where noted, a `.cpuprofile`)
under `harness/.artifacts`:

| Command                                                   | Needs          | What it measures and fails on                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai:test:collection-scale -- --members <n>`               | sandbox        | Installs an offline collection of n already-installed mods. Reports wall time, long tasks, CPU hotspots (`.cpuprofile`) and Vortex's step timings (adding member rules, gathering dependencies, updating rules). Fails on a freeze over 10s. Options below.                   |
| `ai:test:plugins-page -- --plugins <n>`                   | fake Fallout 4 | On the Plugins page with n plugins: rendered rows, and blocking while scrolling, filtering, clearing and toggling a plugin, checking the row follows the toggle. The load order is made deterministic first (below; `--vortex-order` keeps Vortex's).                         |
| `ai:test:download-churn -- --downloads <n> --seconds <s>` | any            | Throttled downloads from a local server (`downloadServer.ts`). Reports persist:diff per minute and per hive, slow writes, dispatches and long tasks. A measurement; it has no pass/fail.                                                                                      |
| `ai:test:mods-scroll -- --mods <n> [--conflicts <pairs>]` | sandbox        | The Mods table under real wheel input: rows on arrival, longest frame gap during a flick, blank rows after it settles, dropdown direction and clipping at both edges, noShrink Status width, rows left rendered after a scroll-through, the conflict editor's virtualisation. |

`ai:test:collection-scale` with no options installs only required members and no rules, as it
always has, so older reports stay comparable. Options add what real collections have
(`collectionScale.ts`, deterministic, so A and B builds get the same collection):

| Option               | Adds                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--optional <f>`     | a fraction of optional members (e.g. `0.1`); they are skipped at the review                                                                     |
| `--glob <f>`         | a fraction referenced by a glob `fileExpression` (`Bundled - x?*`)                                                                              |
| `--duplicates <n>`   | duplicate member entries, alternately with the other type                                                                                       |
| `--rules <n>`        | inter-member `modRules` with tag, literal and glob fileExpression, and unresolvable (logicalFileName) references, duplicates, before-then-after |
| `--update`           | then revision 2, installed as `collectionUpdate` does (`updateOfflineCollection`): drops 5%, flips optional, adds `--extra <n>` (default 50)    |
| `--missing-optional` | optional members are not installed beforehand (a tag nothing has, a bundled file), so the review offers them instead of showing only Done       |
| `--optionals <m>`    | at the review: `skip` (No Thanks, default), `install`, or `stand-in` (Install optional mods, then `completeOptionalsWithoutInstall`)            |

Install and update are reported separately (`phases.install`, `phases.update`): wall time,
`longestFreezeMs`, long tasks, `updatingRulesMs` and the other steps, and the update's
`removeMs`. The freeze budget applies to each. Each phase also records `closedWith` (the button
that closed the review), `dispatches` (perf_trace's count and time per action type, top 40 by
each), `marks` (install-now, review-shown, optionals-install, review-closing, review-closed …:
`performance.mark` in the renderer, and `atMs` from the `.cpuprofile`'s start in the JSON),
`windows` (the profile between consecutive marks: busy time, the app's functions by inclusive
time, the longest freeze), and `inclusive`, `inclusiveApp` and `longestBusy` for the whole phase. Example, the shape QA used for #24283:
`--members 2000 --optional 0.1 --glob 0.04 --duplicates 20 --rules 1000 --update`.

`pnpm run ai:test:large-library` is an opt-in performance check against a running
sandbox instance, for reports that only large mod lists reproduce. It seeds
3,000 small mods (`seedLibrary` in `harness/src/largeLibrary.ts` writes real staging
folders and registers them with one `addMods` dispatch — seconds, no account) and
fails when:

- the Mods table renders more than 200 rows;
- clearing its name filter blocks the renderer for over 2 s;
- any scroll depth shows blank placeholder rows;
- installing 10 mods in a row runs a single main-thread task over 1.5 s;
- a deploy with the modern Mods page takes over 1.6× the same deploy with the classic one,
  whose table always virtualised; with `--max-deploy-ms <ms>`, a Mods-page deploy over that.

The baseline is the classic layout, not another page. The Mods page stays mounted while hidden,
so in a production build a deploy from Settings is exactly as slow as one from the Mods page;
a Mods-against-Settings ratio stays near 1 on both a broken and a fixed build.
`--settings-deploy` still times one, for information.

Deploy times only count after it checks the purge emptied the fixture's files and the
deploy linked all of them. Flags: `--mods <n>`, `--layout modern|classic`,
`--installs <n>`, `--no-deploy`. It writes JSON evidence and a screenshot under
`harness/.artifacts` and restores the layout. Stock 2.7.0 fails every budget (see
KNOWLEDGE.md), so it is outside the stock-compatible `ai:test`. Run it against a
source build with `up --dev-dir <checkout> --sandbox`, and against `--installed` for
a baseline. Keep other CPU-heavy work (builds) off the machine while it measures.

`pnpm run ai:test:mods-scroll` measures the Mods table while scrolling, on a seeded library of
`--mods <n>` (default 3,000), with real wheel input (`page.mouse.wheel` over CDP). It fails when:

- more than 200 rows render on arrival;
- a 40-tick flick has a frame gap over `--max-frame-gap` ms (default 300);
- blank placeholder rows remain on screen 1 s after the wheel stops;
- a row dropdown at the top or bottom edge of the scroll area is cut off by more than 2 px;
- the Status column, which may widen when a band of disabled mods scrolls into view, narrows
  again once it scrolls away (noShrink);
- with `--conflicts <pairs>`, the conflict editor opened on 2 × pairs conflicting mods renders
  more than 200 entries in full on open, after typing in its filter, or after clearing it.

It also scrolls through the whole list and reports how many rows stay rendered and what
clearing the filter then costs. Stock Vortex never unmounts a row it has shown (KNOWLEDGE.md), so
that is a warning, and fails only with `--max-accumulated <n>`. `--no-scroll-through` skips it.
The helpers are in `tableProbes.ts` (`rowsOnScreen`, `wheelScroll`, `jumpAndSample`,
`probeRowDropdown`, `columnWidths`, `seedConflictPairs`, `conflictEditorCounts`) for use on any
SuperTable (`#table-<id>`).

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

`pnpm run ai:test:panels` checks the panel-only layout in a running source
build with `--bethesda-sandbox`. It covers the placement dropdown, a new-panel
chooser restricted to the current sidebar, sidebar focus and replacement,
keyboard resizing, four-panel limit, and separate Home and game layouts.
Match `VORTEX_AI_OWNER` to the running instance. It saves and restores the
existing Home and game workspaces. Every open panel page keeps the sidebar's
selected background; only the focused one has an outline and `aria-current`.
After a clean `down` and `up --bethesda-sandbox`, run with `--verify-saved`
to compare the restored layout with the one recorded by the normal run.

For panel-local actions, `clickByName(mcp, query, { selector, index? })` scopes
the fresh MCP snapshot. This avoids missing controls when a large table consumes
the page-wide node budget. Modern pages put Close in the page header; older
pages and the empty chooser use a fallback action row. The new panel chooser is
`[data-panel-chooser="panel"]`. There are no tab controls or pop-outs.
Click actual content inside each panel: page content is rendered through stable
portals and must activate the surrounding panel too.

Run responsive checks in each relevant state, with distinct artifact labels.
Test both width and height, inspect actual sizes after OS clamping, and visually
review screenshots against any supplied design. Structural warnings are not a
substitute for design review. See the state matrix in [WORKFLOWS.md](WORKFLOWS.md).

Source setup supports checkout paths containing spaces. Git and Node commands
run directly; only the Windows pnpm command shim needs a shell.

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
| `VORTEX_AI_NEXUS_API_KEY`                  | Optional legacy key; sandboxes need `--with-api-key` |
| `VORTEX_AI_HEADLESS`                       | Hide window; screenshots may be blank                |
| `VORTEX_AI_OWNER`                          | Lease owner when `--owner` is absent; `anonymous`    |
| `VORTEX_AI_LEASE_DIR`                      | Lease files; default `~/.vortex-ai/leases`           |
| `VORTEX_AI_KIT`                            | Set by `script`: the `file://` URL of `kit.ts`       |

Run `doctor` with the same setup flags when prerequisites are unclear. No UI write
tools means Vortex started without a token. HTTP 403 means a token/host/origin
mismatch. Startup errors identify the isolated `userData/vortex.log`; avoid
printing whole logs because authentication flows may log sensitive URLs.

If a running instance predates `automation_status`, update its installed extension
and restart it through its existing MCP `vortex_quit` tool before using the new
lifecycle commands. Never treat a port collision as permission to stop an unrelated
Vortex. Do not commit profiles, screenshots with private data, or credentials.
