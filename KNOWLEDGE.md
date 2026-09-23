# Vortex behaviours worth knowing

Things learned the hard way building and running this against a real Vortex.
Every one of them fails _silently_, or with a message that points somewhere else.
If you are debugging something baffling, start here.

## Extensions

### Setup and automation regressions found in September 2026

- A snapshot ref counter that resets to `e1` can make an old ref target a new
  element. Refs now include a renderer lifetime and never reuse a counter within
  it. Test rejection of old refs; testing only increasing snapshot generations
  misses this bug.
- A dialog watcher can invalidate a foreground snapshot before its click.
  `withUiLock` serializes snapshot/action transactions within a harness client.
  Separate clients still need their own coordination.
- An MCP Protocol object owns one transport. Overlapping HTTP bodies must not
  share that object. The delayed-body regression test verifies each response
  still reaches its original client.
- Plain-string UI name matching is exact and case-insensitive. Substring
  matching `Games` also matched `Save games`; matching name plus text duplicated
  labels and broke anchored regexes. Ambiguity must be an error.
- `isLoggedIn` can be true with only an API key. OAuth presence is a separate
  check; a snapshot marker alone never proves a usable login. The harness-only
  credential file tracks refreshes and logout separately from game snapshots.
  Existing credentials may omit the optional fingerprint field.
- A no-game snapshot must have its own key and explicit marker. Treating
  `(skipped)` as a filesystem path makes every no-game start cold.
- Worker fixtures share an app. A lifecycle test using their ports can stop
  the app underneath later tests. Give every additional app its own cache and
  both its own MCP and CDP ports.
- A fake Fallout executable does not isolate game-specific Documents or
  LocalAppData writes. The normal suite registers `vortexaisandbox`; the opt-in
  Nexus smoke test uses Stardew support, which installs this fixture into its
  disposable game directory. Neither fixture proves a real game will launch.
- Collection lookup must match both slug and revision; completion must match
  the returned collection mod ID. Selecting the first collection can report
  unrelated work as complete. Resolve historical revision IDs independently
  from the latest revision number.
- Nexus can return HTTP 504 for dependency lookup after successful earlier
  runs. Vortex then shows dependency-error notifications with no active
  downloads. Report those errors promptly and preserve the profile for retry;
  repeating OAuth login does not fix a service outage.
- Width-only report labels hide height-dependent failures. Record requested,
  actual and inner dimensions, deduplicate issues within each viewport, and
  keep constant findings visible: a defect at every size is still a defect.

### An extension under an ESM package root never runs

Node decides a `.js` file's module type from the **nearest `package.json` up the
tree**. Copy an extension into a directory beneath a `"type": "module"` package
and Node parses its CommonJS bundle as ESM: the module body never executes,
`require()` returns an empty namespace object, **nothing throws**, and Vortex
reports only:

```
corrupt extension, failed to initialize: {"name":"vortex-mcp",...}
```

which says nothing about module resolution. `installMcpExtension` writes
`{"type":"commonjs"}` into the installed directory to pin it. A normal install
under `%APPDATA%/vortex/plugins` has no ESM ancestor, so this only bites
harnesses — which is why it is so confusing when it happens.

### Extensions are renderer-only

`onceMain` is deprecated; `ExtensionManager` logs _"onceMain is deprecated and
won't work as expected"_. Anything needing the main process —
`webContents.capturePage`, `desktopCapturer`, `BrowserWindow` — is out of reach.
Use CDP from outside instead (see `harness/src/cdp.ts`); it works against a
released build and needs no change to Vortex.

### The app-name directory differs between builds

Vortex expects `<appData>/<appName>/startup.json` to exist before launch.
`appName` is Electron's app name:

- released build → `Vortex`
- source checkout → `@vortex/main` (from `src/main/package.json`)

Create the wrong one and Vortex quits during startup with an unrecoverable
ENOENT on `startup.json`, which reads like a corrupt profile.

## Accounts

### An API key logs you in, but not for collections

`isLoggedIn` is `truthy(APIKey) || truthy(OAuthCredentials)`, so setting an API
key satisfies every check the UI makes — the account shows as signed in, and the
Log in button disappears.

Collection downloads are authenticated separately, with OAuth. With only an API
key the download is dispatched and _then_ 401s, surfaced as _"You are not logged
in to Nexus Mods!"_, long after everything said you were signed in. So a
collection install must check for `OAuthCredentials` specifically; checking
`isLoggedIn` passes and then fails minutes later.

Two consequences worth planning around:

- **The API key hides the way to fix it.** Because it satisfies `isLoggedIn`,
  Vortex offers only Logout, and the OAuth flow is unreachable until you log
  out — someone's account session, so ask before ending it.
- **OAuth means a captcha**, which nothing can automate. One interactive login
  is unavoidable.

### Keep the login by copying the directory, not the token

The credential lives in the instance's working directory, so a reset loses it
and the next collection install fails. `save-login` copies that directory over
the snapshot, which cold starts are seeded from.

Copying beats reading the token out of state and re-seeding it the way the API
key is seeded: the credential stays opaque bytes, and there is no dependence on
whatever shape Vortex stores tokens in. Stop Vortex cleanly first — it flushes
state only on window close, and a snapshot taken around a half-written state
database surfaces much later as apparent corruption.

The marker records _that_ a login was captured, as a flag. Knowing the step was
done is all the harness needs; inspecting the credential to find out would be
handling a secret for no reason.

## Isolation

### `VORTEX_E2E=1` is load-bearing, and hostile to discovery

`ELECTRON_USERDATA` / `ELECTRON_APPDATA` are **only honoured when it is set**, and
it also skips the single-instance lock so a harness instance can run alongside
the operator's own Vortex. The released build honours all three, which is what
makes isolated automation against a stock install possible.

The cost: it also disables startup quick discovery and suppresses the
`discover-game` event, so the Games page will never list a game on its own.
Register the path yourself with a raw `type:ADD_DISCOVERED_GAME` dispatch —
faster than a scan and deterministic across machines anyway.

## Building Vortex from here

### A nested package-manager run inherits the wrong pnpm

`pnpm exec` exports a pile of `npm_*` / `PNPM_*` environment variables, and they
pin any child process to the **parent** project's package manager — regardless
of the child's own `packageManager` field or working directory. Running Vortex's
`pnpm install` from a script that this repo's pnpm launched therefore used
pnpm 9 instead of the 11 Vortex requires, and failed with:

```
WARN  Ignoring broken lockfile ... expected a single document in the stream
ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER  node@runtime:24.17.0
```

Neither message mentions a version mismatch. The lockfile is fine; pnpm 9 just
cannot read one pnpm 11 wrote, and does not understand `node@runtime:` specs.
`childEnv()` in `harness/src/source.ts` strips those variables.

### Capturing output makes a slow step look like a hang

`pnpm install` in a Vortex checkout downloads an Electron binary and rebuilds six
native modules — many minutes of steady output. Captured rather than streamed,
it is indistinguishable from a wedged process, and gets killed as one. Long steps
stream; only short, quiet commands capture.

## Games and profiles

### `activate-game` is a dead end for a game with no profile

Its handler calls `activateGame`, which on finding no profile shows a "Choose
profile" dialog whose choice list is **empty** — unanswerable, so activation
hangs forever. It also takes **no callback**, so `vortex_dispatch`'s
`__CALLBACK__` sentinel waits on something that never fires.

`manageGameDiscovered` — which creates the first profile _and_ initialises and
tags the staging directory — is not exposed through `registerAPI`; only
`unmanageGame` is. The working route is the UI: Games page → search → hover the
tile → the manage button.

### The manage button's label and shape move between versions

- Vortex 2.6.3: `button.action-manage`, labelled **"Manage"**, inside a
  `.hover-content` wrapper at `opacity: 0`.
- Newer layouts: labelled **"Add game"**.

Match on the class where possible and treat the label as a fallback.

## The UI

### Synthetic hover cannot trigger CSS `:hover`

Dispatching `mouseover`/`mouseenter` runs React handlers but does **not** change
the browser's hover state. Anything revealed purely by a CSS `:hover` rule stays
at `opacity: 0`, and a snapshot correctly reports it hidden — which looks like a
snapshot bug and is not.

Either click it anyway (`ui_click` with `requireActionable: false`, since the
event is dispatched on the element rather than at a coordinate), or use the
harness's `realHover()`, which moves a real mouse over CDP.

### Three ways a snapshot can silently go blank

All three were real bugs in this extension, each of which deleted part or all of
the UI from `ui_snapshot` rather than failing:

1. **`display: contents` wrappers** generate no box, so `getClientRects()` is
   empty while their children render normally. Pruning on that removed Vortex's
   entire game grid. Zero client rects now only disqualifies an element from
   being _clicked_.
2. **`getComputedStyle().opacity` can be `""`**, and `Number("") === 0`, so a
   naive zero-check reads an unresolved value as fully transparent. Only a value
   that actually parses to 0 counts.
3. **`aria-hidden` on the app root.** react-bootstrap sets it on Vortex's
   `#content` and `#overlays` whenever a modal opens, so treating it as invisible
   blanked the entire snapshot at exactly the moment an agent most needs one.
   It means "hidden from assistive technology", not "not rendered" — it is
   reported per node as `ariaHidden` instead.

### A button's accessible name is not its text

`ui_snapshot` reports accessible names, and Vortex's buttons routinely carry an
`aria-label` or `title` that differs from what they render. The External Changes
dialog's confirm button reads **Confirm** in devtools and is named **Confirm
changes**; its cancel button reads Cancel and is named "Cancel deployment".

So a selector written by inspecting the DOM can match nothing while looking
obviously correct — and a dialog policy that matches nothing is silent: the
modal stays open, blocks whatever raised it, and reads as a hang. That cost
three attempts on one dialog here.

Write policies against the name `ui_snapshot` reports, not the text devtools
shows, and prefer a prefix (`/^confirm/`) over an anchored exact match. Icon
buttons are the same story from the other side: their text is empty and the name
comes entirely from the attribute, so a text-based DOM query misses them.

### Several widgets listen on `mousedown`, not `click`

`HTMLElement.click()` dispatches only a `click` event, so dropdown toggles and
table row selection never respond to it. Dispatch the full pointer/mouse
sequence — which `ui_click` does.

### React ignores a direct `.value` assignment

React tracks the last value it wrote on the DOM node. Assigning `el.value`
updates the DOM but leaves the tracker stale, so React swallows the synthetic
`input` event and `onChange` never runs — the classic "typed into the box but
nothing happened". Call the prototype's native setter first, as `ui_fill` does.

### Stacked modals: `:nth-of-type()` cannot select between them

Vortex mounts each modal under its own parent, so two open dialogs are not
siblings. Every `div:nth-of-type(n)` therefore matches _both_, `querySelector`
keeps returning the first, and the second dialog is unaddressable by CSS alone.

The failure is silent and misleading. A purge prompt stacked behind a collection
report went unanswered for the whole run: the policy matched its text fine, but
the scoped lookup kept landing in the wrong dialog, so it read as "no policy for
this dialog" — while the unanswered modal blocked the install driver, which read
as a hung collection.

`ui_snapshot` takes an `index` alongside `selector` for this: the nth _match_,
which is the thing CSS cannot express. Note that `[role="dialog"]` can match
several nested elements of a single dialog, so indices are not one-per-dialog —
confirm with the dialog's text before acting, as `clickInsideDialog` does.

### A mod exists in state before it is installed

A mod row appears the moment its install _starts_, not when it finishes. Until
the installer completes it sits at `state: "installing"`, shows its archive
filename rather than its real name, and stays disabled. For a mod with a FOMOD,
"until the installer completes" means until someone answers the wizard.

So counting mods counts installs that have merely begun. A collection reported
8/8 complete while four members were still installing, deploy ran over the
half-installed set, and the game launched with a wizard still open on screen.
The archive-named disabled rows are the tell, and they look like a cosmetic
quirk rather than the signal they are.

Wait on `state === "installed"`, **and** on nothing being left in `installing`.
Neither alone is enough: the count can be reached while later members are still
going, and "nothing installing" is briefly true in the gap before the next one
starts. Anything that writes to the game directory should refuse while mods are
installing, because deploying then links a half-extracted set and the result
reads as a broken collection rather than an unfinished one.

### FOMOD steps do not have a predictably-named forward button

Vortex labels a FOMOD installer's forward action after the step it is showing,
so a single collection puts up `Next`, `Install`, `Finish`, `Default Settings`,
`Installation`, `Readme and information` and
`Basic - name reordering for weapon/apparel - Language` across consecutive mods.

Matching on the label therefore handles a few mods and then sits forever on one
it does not recognise. Nothing errors: the install driver is simply waiting on a
modal, so it reads as a hung collection. This stalled the harness at 8 of 12
mods.

Match on **position** instead: `#fomod-installer-dialog .fomod-nav-buttons`
holds Back (when there is a previous step), a progress bar, and the forward
action last. Cancel is not in that bar — it is `#fomod-cancel` in the dialog
header — so the forward action is just the bar's last button. `advanceFomod()`
does this.

Two things that look like details and are not:

- **Scope to the nav bar, never to the dialog or the page.** "Click the last
  button in the dialog" generalises the rule and breaks it: on "Purge files from
  different instance?" the last button is _Purge_, against a real game install.
  A page-wide search is worse still — Vortex's titlebar has a button called
  `Close`, so answering a dialog's `Close` by name finds the window control and
  shuts the app down mid-install. Both have happened here.
- **Do not skip disabled buttons before taking the last one.** A step can render
  with its forward button briefly greyed out; filtering disabled entries first
  makes the rule fall through to _Back_ and walk the wizard backwards forever.
  Take the last button as it is, and if it is disabled, do nothing and re-poll.

### Virtualised rows are not in the DOM

Vortex's mod, plugin and game lists are windowed: a row simply does not exist
until the list is narrowed or scrolled to it. Filter with the search box rather
than scrolling — far more reliable. And scrolling needs a real `scroll` **event**,
not just a `scrollTop` assignment, or the new rows never mount.

### Verify tool schemas after reload; a responding port can still be the old server

Older reload paths could leave the previous MCP server listening. A handler
appeared updated while its tool registration still had the old input schema.

The result is a half-updated extension that is easy to misread. A new parameter
is rejected by the old schema and silently stripped before the handler sees it,
so the handler runs the new code with the argument missing and returns a
perfectly normal result. Nothing errors. It looks exactly like the new code not
being loaded — and led to a "verified against the live app" claim here that was
really the old schema discarding the argument.

The current harness waits for `automation_status.runtimeId` to change, and real
tests verify the new renderer rejects old refs. After a schema change, also
inspect `tools --json`. If the new schema is missing, perform a full
`vortex-ai down` / `vortex-ai up` cycle; a successful request alone is not proof
that the rebuilt extension loaded.

### Installing the extension: `installMcpExtension` appends `userData` itself

It takes the _instance_ directory and joins `userData/plugins/<id>` onto it.
Passing the userData directory produces `userData/userData/plugins/...`, which
Vortex never reads — so the extension keeps running the previously installed
build and every change appears to have no effect.

## Deployment

### A cleared primary tool is `null`, not absent

Clearing a game's primary tool writes `null` rather than removing the key, so an
`!== undefined` check treats it as a tool named "null" and refuses to launch.
Callers that mean "just run the game" have to clear it _and_ the reader has to
treat `null` and `""` as unset.

Worth knowing too: a seeded profile carries its recorded tools with it, so an
instance restored from a snapshot can have a primary tool that no longer works.
Two different failures look identical from the outside:

- the recorded path is **gone**, or
- the path still exists but the binary is **stale** — a backup F4SE built for
  another game version, for instance — so it spawns cleanly and exits having
  started nothing.

Either way `runExecutable` resolves, which only means the process was _started_,
never that it stayed up or that a game appeared. Nor is the tool's own process
the thing to watch: a loader is _supposed_ to exit once it has handed off, so a
working loader and a dead one both leave nothing behind.

Watch for the **game's** executable in the OS process list instead, and fall
back to launching it directly when it never shows up. That is what `launchGame`
does; `processWaitMs` exists so tests need not wait it out.

### Deploying over another instance's files is blocked

Vortex prompts _"Purge files from different instance?"_. Answer Cancel
unattended: a real install can have tens of thousands of deployed files (31,102
on the machine this was built on), and purging is the direction Vortex itself
calls "less reliable". Use a disposable game directory to exercise deploy/purge.

## Shutdown

### Kill the process and you can corrupt the profile

Vortex flushes pending state diffs only on a proper window close: the renderer
writes them synchronously, then main waits for it to release its file handles. A
hard kill skips that and can leave the state database half-written — which shows
up much later as a stale or corrupt profile rather than as an error at the time.
`vortex_quit` closes the window, which is the same path as clicking the X.

### Windows holds file handles after exit

The state database releases its handles a moment _after_ the process is gone, so
an immediate `rmSync` loses the race with EPERM. Retry with backoff.

Directory **renames** are worse: they can fail with EPERM for reasons unrelated
to Vortex (an indexer or scanner holding a transient handle on any descendant),
and retrying does not reliably help. Prefer building in place and writing a
marker file last over the staging-directory-then-rename pattern.
