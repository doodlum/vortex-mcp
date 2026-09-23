# Automation validation

Validated on Windows on 2026-09-23 against released Vortex 2.6.3, with a separate
authenticated installation run against the managed source build. These results
describe this environment; they do not certify every game or extension.

Final results: 242 unit tests and all 18 stock-app tests passed. The opt-in zoom
workflow also passed against the source build in signed-in and signed-out states.
The opt-in Nexus
smoke command passed with five required members and 474 verified deployed files.
The documented `setup --oauth` command also captured and restored an existing
login automatically. The original harness session was restored after review.

| Layer             | Evidence                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository gate   | `pnpm run ci`: extension/harness types, lint, formatting, 242 unit tests, build                                                                        |
| Real app          | `pnpm run ai:test`: disposable profiles and ports, sandbox game, no account                                                                            |
| Zoom feature      | `pnpm run ai:test:zoom`: signed-in/out shortcuts, timers, focus, persistence, legacy isolation, every-frame geometry, recordings                       |
| Pull requests     | `pr-checks 24274`: exact current head and green checks; unit fixtures distinguish test failures from report encryption/upload failures                 |
| Lifecycle         | Cold, warm, fresh, no-game, game switch, clean shutdown, unsigned capture rejection                                                                    |
| UI                | React search/fill/clear, exact targeting, disabled control, stale refs, keys, select, scroll, real hover, waits, screenshots, console, renderer reload |
| Responsive        | Width and height changes independently, recorded dimensions, PNGs and JSON findings, original size restored                                            |
| Local mods        | ZIP install, enable, deployed file contents, disable, redeploy, purge                                                                                  |
| OAuth             | Existing login migrated; credentials restored into a blank profile and reused after clean restarts without another login                               |
| Nexus collections | `stardewvalley/nudx7b`, revision 1: 5/5 required members; completion independently visible in Vortex                                                   |
| Real deployment   | All 474 deployed files matched staging SHA-256 hashes; purge removed all 474                                                                           |

The authenticated workflow is reproducible with `pnpm run ai:test:nexus` after
`setup --oauth`. The initial validation also drove the sequence through the
generic harness APIs and `runE2e(..., { skipLaunch: true })`.

An additional fresh-profile repetition encountered Nexus HTTP 504 responses
during dependency lookup. The preserved profile showed five dependency-error
notifications and no download progress. The harness now reports new dependency
or download failures after 30 seconds without progress instead of waiting for
the entire collection timeout. The subsequent `ai:test:nexus` run passed after
the service recovered, again verifying all 474 deployed files and purge. Retry
with the same URL and settings after recovery; credential presence is not proof
of an available service.

Artifacts are local and gitignored: `harness/.artifacts/` contains screenshots,
responsive JSON, and `nexus-smoke-*.json`; Playwright's HTML report is under
`harness/playwright-report/`. Tests use independent DOM/filesystem observations
where possible, rather than trusting only a tool's success response.

Boundaries: this review did not launch a real game, automate password/MFA/captcha,
certify every native dialog, or validate every responsive state of Vortex itself.
The Stardew executable is a path marker. Initial login remains the account
owner's step; cached access and refresh credentials are kept privately and
refreshed by Vortex. Unit tests cover rotation and logout tombstones; real token
expiration and revocation may require account setup again. Unattended Nexus
member downloads require a suitable account (Premium on the tested build).
