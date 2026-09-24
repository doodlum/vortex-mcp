# Vortex behaviours worth knowing

### Transient zoom movement needs frame checks

Settled bounds can pass even while chrome visibly jumps during a zoom gesture.
Electron's native zoom updates can replay an older factor after React has already
rendered compensation for a newer one. Modern zoom now uses CSS scaling and a
shared CSS variable for the fixed chrome. `ai:test:zoom` samples every animation
frame during rapid scaling, in addition to checking settled geometry.

### A running source app can block verification

Even without a dev watcher, the source app holds plugin DLLs such as `libloot.dll`
open. Nx cache restoration reports only "Access is denied"; an uncached build
reveals the locked file in `copy-extensions`. Stop the harness instance cleanly
with `vortex-ai down` before the complete Vortex `verify` gate, then restart it.

### Electron zoom and screenshot clipping

At non-default `webFrame` zoom, Playwright's viewport screenshot can derive a
CSS-pixel clip that crops the right and bottom of the actual Electron surface.
This can falsely make title-bar buttons look off-screen. The harness now uses
CDP `Page.captureScreenshot` without a clip and with `captureBeyondViewport: false`
for viewport captures. Full-page captures retain Playwright's separate path.
Check rendered bounds as well as screenshots when testing zoom.

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

### Electron window events can precede navigation

Playwright can emit `window` while the main renderer still has an `about:blank`
URL. Checking only that event for `index.html` misses a fully working Vortex and
times out in fixture setup. Watch navigation on candidate windows too. After a
renderer reload, wait for the title bar before asserting state: extension loading
can outlast the default five-second assertion timeout.

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
`childEnv()` in `harness/src/source.ts` strips those variables. The source setup
also reads Vortex's exact `packageManager` version: it uses `pnpm` directly only
when that version matches, otherwise it runs the pinned version through
`pnpm dlx`.
This prevents a newer global pnpm from silently deciding to replace an existing
dependency layout in a non-interactive session.

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

### A hidden Electron window does not paint like a visible one

The upstream E2E suite defaults to `VORTEX_E2E_HEADLESS=1` and `--disable-gpu`.
A local headed pass is not a CI pass. In the zoom regression, a hidden window
produced only three animation frames in 2.2 seconds, and Headless UI's exit
transition remained mounted after the three-second timer had fired. Both failures
reproduced locally with `CI=1` and `VORTEX_E2E_HEADED` unset. Setting
`webContents.setBackgroundThrottling(false)` did not help; Vortex already uses it.

Tests that assert animation frames must render their own window:
`const window = await vortexApp.browserWindow(vortexWindow);`
`await window.evaluate(window => window.showInactive());`
This retains the normal CI launch and GPU settings without taking keyboard focus.
Keep the frame-count, geometry and timer assertions; do not lower them to make
hidden-window throttling pass. Other tests can keep their windows hidden.

CI also runs account tests without secrets on fork PRs, and its encrypted report
step prompts and exits 255 when the password is empty. Separate these failures
from UI regressions. A test step marked successful with `continue-on-error` does
not mean its tests passed; read the Playwright summary in the log. The harness's
`pr-checks` command correlates PR checks with workflow job steps and calls this
out as a post-processing failure when the actual test step succeeded.

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

### The 2.7 Mods page renders every row, and that is the large-list slowdown

On stock 2.7.0 (and 2.8-beta/master as of September 2026) the modern Mods page
passes `stickyHeader` to SuperTable. That sets `.table-main-pane { overflow: visible }`
so the page scrolls the table instead, but each row's `VisibilityProxy` still roots its
IntersectionObserver at that pane. A root that doesn't clip counts its whole box as
visible, so every row renders in full: 3,000 of 3,000 with 21 on screen. Nothing errors.
It shows up only as slowness proportional to the mod count, which users reported as
"deploy is 6× slower than 2.6", "clearing the filter takes 10–30 s" and "freezes during
a collection install". Every dispatch (per-mod deploy progress, install steps) now
re-runs thousands of rows' connected cells. The Mods page also stays mounted while
hidden (`invisible`, not unmounted), so it slows other pages too, Plugins included.

Measured in **production** builds (`--production`), 4,000 mods, unpatched against patched
master (Nexus-Mods/Vortex#24281), 3 runs a side, with `ai:test:large-library` and the probes now
in `ai:test:mods-scroll`:

- rows rendered in full, with 21 on screen: 4,000 → 27;
- clearing the name filter blocked the UI for 14.2–19.3 s → 0.31–0.50 s;
- deploy: 28.9–31.7 s → 15.2–16.9 s on the Mods page, and 28.5–32.3 s → 15.2–16.9 s from
  Settings. The Mods page was **not** slower than Settings: the hidden Mods page stays mounted,
  so the fix halves deploy on every page;
- 20 sequential installs: 43.6–55.4 s → 32.8–33.5 s (longest task 450–709 ms → 359–375 ms);
- a 40-tick wheel flick: longest task 434–533 ms → 134–146 ms.

Earlier figures here (deploy 63 → 31 s, installs 221 → 33 s, rows 3,000 → 24, filter clear
11.0 → 0.37 s) came from development builds, whose React is several times slower at rendering.
Don't quote them. A single run of the stock 2.7.0 installer took 403 s to deploy from the Mods
page against 38 s from Settings (10.7×, like the reported 12 min against 2 min). Production
builds of master did not reproduce a Mods-against-Settings difference, so compare against the
classic layout instead (`ai:test:large-library` does).

The classic layout, whose pane scrolls itself, was never affected; use it as the
in-build control. The fix roots the observer at the element that actually scrolls
(`scrollContainerOf`). It lives on the Vortex branch `fix/sticky-table-virtualisation`.

Traps found while measuring:

- A deploy timing is worthless unless the purge before it removed the fixture's files.
  Otherwise the next "deploy" is incremental and fast. Installing a mod triggers
  Vortex's auto-deploy, which races a purge started right after and leaves files
  behind, so the check turns auto-deploy off for its run.
- Never delete fixture files a purge left behind while `vortex.deployment.json` still
  lists them. (Copies no manifest lists, left by an interrupted run, are invisible to
  Vortex and the check removes those.) Vortex still owns listed files, so the next
  deploy stops on External Changes, "Links were deleted". Every row there defaults to
  **Save change (delete file)**, which deletes the mods' _staging_ files. The
  harness's Confirm policy would have accepted that for 3,000 mods; only the
  snapshot's node limit hid the footer button. The policy now refuses whenever links
  were deleted, and reports the dialog instead. Answer it in Vortex, with
  **Revert all changes** to restore the links.
- A long check piped through `Select-String` or `Select -Last` shows nothing until it
  exits, so a hang looks like a slow run. Tee to a file, or watch progress through the
  game directory and `list_notifications`.
- tsx compiles named functions with an `__name` helper that the page does not have.
  Pass `page.evaluate` source text, not a function, from harness scripts.

### A row stays rendered forever once it has been on screen

`VisibilityProxy` ignores a "not visible" callback that arrives within 1 s of the row becoming
visible (the `now - this.mVisibleTime > 1000` guard). An IntersectionObserver reports only
changes, so for a row scrolled past quickly it never reports again, and the row stays rendered
in full. Scrolling therefore undoes the virtualisation a bit at a time. Nothing errors.

Production build with the sticky-header fix (#24281), 4,000 mods, after one wheel scroll through
the list: 1,109 rows rendered, clearing the filter blocked 4.95 s again, and scrolling was
blocked for 122 s of the 131 s it took. The classic layout, never affected by the sticky header,
does worse: 2,175 rows, 7.8 s to clear the filter. Forty wheel ticks alone leave 417 rows
rendered, so "it drops back to about 36" is not true either. Present in 2.6 through master of
September 2026. `ai:test:mods-scroll` reports it as a warning, and fails on it with
`--max-accumulated <n>`.

### After a completed collection, Vortex stops running its checks

`InstallDriver.startInstall` suppresses the `plugins-changed`, `mod-installed`,
`mod-activated` and `settings-changed` checks while a collection installs, and only cancel
or pause released them. A successful install ends through the review screen's Done/Close,
which did not. So Missing Masters, and every other check on those events, never ran again
until restart. Nothing is logged: the test runner drops suppressed events without a trace.

This is present in 2.6 through master of September 2026, and fixed by
Nexus-Mods/Vortex#24282. It is reproduced by `ai:test:bethesda`, and visible with
`check_probe_counts`, whose `plugins-changed` count stops rising.

### A Bethesda collection without a plugin list skips the end of its postprocessing

For a gamebryo game, postprocessing calls the collection parser, which reads
`collection.plugins.find(…)` for every plugin its members installed
(`util/gameSupport/gamebryo.tsx`, around line 212). Vortex's exporter always writes that list.
A hand-made collection.json without it makes the parser throw. The error is swallowed, so plugin
enabling and `collection-postprocess-complete` are skipped. The review's Done still enables and
the install looks complete. `offlineCollection.ts` writes the list, and `installOfflineCollection`
reports `postprocessed` from the event.

### A collection installed from a file has no revision

`start-install <archive>` installs the collection mod with `archiveId: null`. The install driver
reads revision id, slug and `revisionInfo` (including `gameVersions`) from that download's
`modInfo`, so with no download the game-version prompt and anything revision-based can't be
reached. Nothing says so. Register the archive as a download first (`addLocalDownload`, then
`start-install-download`), which is what Vortex does itself for a downloaded collection.
`addOfflineCollection` does this. With `nexus.revisionInfo.modFiles` present on the download, the
driver takes `revisionInfo` from it instead of asking Nexus.

### The collection InstallDriver is not reachable from an extension

The driver is a module variable of the collections extension. `registerAPI` exposes only
`getActiveCollectionInstallSession` (the same object as `state.session.collections.activeSession`),
not its `step`. The step alone decides which dialog shows, and `start` auto-continues on the next
driver update, so a test can't tell "waiting at Install Now" from "about to begin" by state.
Vortex does pass the driver as the `driver` prop to its always-mounted collection dialogs, and
`collection_install_state` reads it from React's fiber tree. That is a private shape. The tool
says `found: false` when a build stops passing the prop.

### A seeded API key makes every local install wait a minute

With an API key, Vortex looks locally installed archives up on Nexus. For a fixture archive QA
saw that lookup end only at its 60 s timeout, so each sandbox install took a minute longer and
looked hung, with nothing in the UI. `up` used to seed `harness/.env`'s key into
sandbox profiles. Sandbox runs now leave it out unless `--with-api-key` is given.

### Measuring a slow Vortex without measuring the harness

Three things made measurements wrong, found while profiling 2,000-member collections:

- **The observer was the hotspot.** The dialog watcher and the collection driver polled a
  full `ui_snapshot` every second. Each measures every rendered element, and with a big mod
  list that made `getBoundingClientRect` the top entry in the profile. Poll with
  `ui_active_dialogs` instead.
- **"fetch failed: ECONNRESET" meant the renderer was frozen, not broken.** The MCP server
  lives in the renderer. Node's 5s keep-alive timeout fired late after a long freeze and
  closed a socket as the client reused it. The server now keeps idle sockets for 10 minutes,
  and pollers retry.
- **Development React.** Source builds run React's development build unless started with
  `--production`, so rendering-heavy timings are inflated there.

What the profiles showed, for next time:

- **Collections.** `minimatch` recompiling each member's fileExpression for every installed
  mod took 36% of CPU. `ADD_MOD_RULE` compared every rule with `_.isEqual` per add (25s for
  2,000 rules). `updateRules` ran a linear scan per member (Nexus-Mods/Vortex#24283).
- **The Plugins page.** Toggling a plugin renumbers every row, and SuperTable copied its
  whole value cache per changed row (Nexus-Mods/Vortex#24284). Clearing the filter (about
  1.2s) is spread across React, react-select's AutosizeInput and `nameMatch`, with no single
  hotspot.
- **Downloads.** Progress and speed dispatch once a second each, both into the persisted
  `persistent.downloads` hive: 94 persist:diff per minute with four downloads (LAZ-1168). No
  slow writes or long tasks reproduced without a real collection's database load.

### Getting code into Vortex's main process

Packaged and source builds need different routes to redirect Documents, and three
obvious ways fail silently:

- **`--inspect-brk` hangs every install.** The released build honours it, but Node worker
  threads inherit break-on-start. Vortex hashes archives in a worker, so every install
  waits forever. There is no log line, and the renderer and MCP server look healthy.
  Stripping `process.execArgv` does not help: workers copy the parent's _parsed_ options.
- **`inspector.close()` from the session that is still attached deadlocks main.** It
  blocks until no session is connected. Main then sits at 0% CPU and stops logging.
- **A `--require` preload cannot use `require("electron")` directly.** The built-in module
  does not exist yet, so it resolves to the npm package's path string. Hook `Module._load`
  and act on the app's own first `require("electron")`, as `mainPreload.ts` does.
- **Paths in NODE_OPTIONS:** quoted backslashes are escapes, so use forward slashes.

Packaged Vortex (2.7.0) ignores NODE_OPTIONS, so this only works on source builds. The
harness verifies a record the preload writes and kills the instance within 5s otherwise,
before a game can activate. `automation_status.paths` reports what Vortex actually resolved.

### A reset profile does not reset the game directory

`--fresh`, cold and rebuild starts replace Vortex's profile, staging included. The game
folder kept the previous run's deployed files and `vortex.deployment.json`. The next deploy
then stops on External Changes, "Source files were deleted", and purges leave strays.
Bootstrap now empties a disposable game's `Data` (keeping `Fallout4.esm`) and its plugin
lists whenever the working profile is reset. It only touches games inside the cache.

In the External Changes dialog, "Source files were deleted" → Save removes deployed copies
of files whose source is already gone. "Links were deleted" → Save deletes the **staging**
files. The harness confirms the first and refuses the second.

### Virtualised rows are not in the DOM

Vortex's mod, plugin and game lists are windowed: a row simply does not exist
until the list is narrowed or scrolled to it (except the 2.7 Mods page — see above,
where every row renders until the sticky-header fix lands). Filter with the search box rather
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

## Tooling on Windows

### `git commit -F -` fails with a PowerShell here-string

In Windows PowerShell 5.1, piping a here-string into `git commit -F -` fails with "did not match
any file(s)", so it looks like a pathspec error. Write the message to a file and pass
`git commit -F <file>`.

### A commit message file written by PowerShell starts with a BOM

Windows PowerShell 5.1's `Set-Content -Encoding utf8` and `Out-File -Encoding utf8` write a
byte-order mark, and `git commit -F <file>` keeps it as the first bytes of the subject. Use
`[IO.File]::WriteAllText($path, $msg)`, which writes UTF-8 without a BOM.

### JSON saved from PowerShell starts with a BOM too

The same byte-order mark breaks JSON read back by Node: `JSON.parse` fails with "Unexpected
token", so a `vortex-e2e --compare` baseline or a `call --args-file` saved with `Out-File
-Encoding utf8` or `Set-Content -Encoding utf8` looks corrupt. Every JSON file the kit reads back
goes through `readJsonFile` in `harness/src/jsonFile.ts`, which strips the mark. Write new readers
the same way.

### A scratch script outside the repo can't import the kit by path

Two separate failures. tsx treats a `.ts` file with no ESM `package.json` above it as CommonJS,
so top-level `await` fails; name it `.mts`. And on Windows an absolute path in an import,
`C:\dev\…`, is parsed as a URL with scheme `c:`; use `file:///C:/dev/…`. Bare names such as
`fflate` still don't resolve from outside the repo. `vortex-ai script <file.mts>` runs it with the
kit's tsx and passes the URL of `harness/src/kit.ts`, which re-exports what scripts need, in
`VORTEX_AI_KIT`.

### `oxfmt` with a PowerShell array fails

`pnpm exec oxfmt $files`, where `$files` is a PowerShell array, fails with "Expected at least one
target file". Pass each path as its own argument, or use `@files` splatting.

### Silent `oxlint` looks the same as no `oxlint`

`pnpm exec oxlint <files>` prints nothing when the files are clean, so you can't tell a pass from a
run that checked nothing. In a Vortex checkout, `pnpm nx run @vortex/renderer:lint` prints an
explicit result. Use that as the evidence.

### Vortex's E2E suite cannot give a local baseline as-is

On this machine, stock `packages/e2e` has two problems:

- The account specs fail instantly: "Missing required environment variable
  E2E_NEXUS_FREE_USER_USERNAME".
- Almost every other spec fails in fixture setup with "Vortex process exited unexpectedly with
  code 0 before the main window appeared", then waits out its 6-minute timeout. That's a
  main-window startup race in `packages/e2e/src/fixtures/vortex-app.ts`.

A full run takes about 6 hours and proves nothing. Upstream CI runs E2E only when `packages/e2e`
changes, or on a schedule on self-hosted runners that have the test accounts. So PRs outside that
path never get E2E in CI, and the local run is the only E2E gate. Use the kit's E2E runner,
`pnpm run ai:vortex-e2e -- --checkout <dir>` (see harness/AGENTS.md, "Vortex's own E2E suite"). It
applies `harness/patches/e2e-window-startup.patch` for the run and restores the file byte for byte,
and leaves out the account specs whose credentials are absent, reporting them separately. Don't
run bare `playwright test`.

The account specs can't be skipped by file: `game-management.spec.ts` mixes a signed-out test with
a free-user one, and the tier loops (`account.spec.ts`, `mods*.spec.ts`) set `nexusUser` from a loop
variable. The runner reads each describe's `test.use({ nexusUser })` and the tier in its title.
