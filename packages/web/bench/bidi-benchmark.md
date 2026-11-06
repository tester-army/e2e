# WebDriver BiDi vs Playwright

Experimental BiDi driver for `@e2e-dev/web` (`web({ driver: 'bidi' })` or `E2E_WEB_DRIVER=bidi`), compared against the Playwright driver on the same machine, the same browser binaries and launch flags, and the same engine contract.

## Approach

- **Client:** a thin BiDi client of our own (`src/bidi/connection.ts`) over Node's built-in `WebSocket`, typed with `webdriver-bidi-protocol`. No WebdriverIO: its `webdriver` package wants a driver binary per browser and adds a session layer the engine does not need.
- **Firefox:** native BiDi (`--remote-debugging-port=0`, `ws://…/session`). No geckodriver.
- **Chromium:** the `chromium-bidi` mapper over CDP, in a child process (`mapper-process.ts`) as chromedriver hosts it. No chromedriver. It boots in parallel with Chrome. Remote endpoints (`connect`, worker-scoped providers) go through the same mapper.
- **Binaries and flags:** both drivers launch what Playwright installed (Chromium headless shell 156, Playwright's Firefox 157 build). Chromium gets Playwright's switches and disabled features; Firefox gets the profile prefs Playwright's own BiDi launcher writes.
- **Same contract:** `BidiSurface` implements the hooks `PlaywrightSurface` does and reads pages with the same in-page reader, so observations match. Locate runs the contract's reference resolver (`resolveExpression`) over node-mode reads, after an in-page superset prefilter (role, then accessible name; attributes; text), so the resolver stays the only judge.

## Mapping

| Playwright | WebDriver BiDi | Status |
| --- | --- | --- |
| `launch` | spawn + `session.new` (Chromium via the mapper) | done |
| `connectOverCDP`, browser providers | mapper over the remote CDP endpoint | done for `connect.cdpEndpoint` and provider scope `worker`; persistent context (`reconnectEndpoint`, scope `attempt`) not built |
| `newContext` / `close` | `browser.createUserContext` / `removeUserContext` | done |
| `newPage`, viewport | `browsingContext.create`, `setViewport` | done |
| `goto` / `reload` / `goBack` / `goForward` | `browsingContext.navigate` / `reload` / `traverseHistory`, landed when the document reads complete on another history entry (same-URL `pushState` entries included) | done |
| `waitUntil: 'networkidle'` | no BiDi wait; built on `network.beforeRequestSent` / `responseCompleted` / `fetchError`: no request of the test's tab in flight for 500 ms | done |
| `evaluate`, element handles | `script.callFunction` with shared ids (nothing to dispose) | done |
| `addInitScript` (config and mid-test) | `script.addPreloadScript` per user context | done |
| locators | in-page reads + `resolveExpression` (labels and display values as Playwright reads them); CSS per open shadow root, XPath via `browsingContext.locateNodes` | done; Playwright selector syntax (`text=`, `>>`) and CSS combinators across a shadow root not supported |
| `frameLocator`, frames in observations | `contentWindow` → child context; boxes and pointer points mapped through each frame's offset and scale | done; rotated or mirrored frames refused for pointer actions |
| click / dblclick / hover / mouse / keyboard | `input.performActions` + in-page actionability (visible, enabled, stable, clipped by scroll containers, hit-tested through every frame); held modifiers tracked per tab | done |
| drag (HTML5 `dataTransfer`) | Chromium: CDP `Input.setInterceptDrags` + `dispatchDragEvent` through `goog:cdp`, as Playwright's Chromium driver does | done on Chromium; Firefox gap (below) |
| `fill` | in-page `execCommand('insertText')`: one trusted edit, no key events, as Playwright's `insertText` | done |
| `setInputFiles`, file chooser | `input.setFiles`; `input.fileDialogOpened` for a control that opens one | done |
| `selectOption`, `check` | in-page, as Playwright does | done |
| `screenshot` + mask + caret | `browsingContext.captureScreenshot` + in-page boxes in closed shadow roots (inside each top-layer element, or in a manual popover), verified to cover every field after capture | done |
| `route`, `fulfill` / `continue` / `abort` / `fallback`, `postData` | `network.addIntercept` (scoped to the attempt's tabs), `provideResponse` / `continueRequest` / `failRequest`, request data collector | done |
| `waitForResponse`, `response.text()` | `network.responseStarted` (headers) + the attempt's response collector; the body after `responseCompleted` / `fetchError` | done |
| `extraHTTPHeaders` (site-scoped) | intercept + `continueRequest` headers for the app's site | done |
| `httpCredentials` | `authRequired` intercept + `continueWithAuth` | done |
| dialogs | `browsingContext.userPromptOpened` + `handleUserPrompt`, through the shared `DialogRouter` | done |
| downloads | `browser.setDownloadBehavior` + `downloadWillBegin` / `downloadEnd` | done |
| `userAgent`, `locale`, `timezoneId` | `emulation.setUserAgentOverride` / `setLocaleOverride` (+ `accept-language`) / `setTimezoneOverride` | done |
| `colorScheme`, `reducedMotion`, `emulateMedia` | `emulation.setMediaFeaturesOverride` | Chromium done; Firefox: config values as launch prefs, `emulateMedia` mid-test waits on Firefox 159 |
| permissions | `permissions.setPermission` per origin | done |
| `storageState` | `storage.getCookies` / `setCookie` + localStorage and IndexedDB of every visited origin, read and written in a scratch tab on a blank page the network serves | done (IndexedDB values JSON or `Date`) |
| app log | `log.entryAdded`, `network.responseCompleted` / `fetchError` | done |
| video | Firefox: native `browsingContext.startScreencast` (VP8 webm). Chromium: the mapper lacks it, so CDP `Page.startScreencast` through `goog:cdp`, encoded to VP9 webm with Playwright's ffmpeg | done |
| WebKit | no BiDi endpoint in Safari | out of scope, `BidiBrowserName` keeps the seam |

## Correctness

Built packages, real CLI, at 30f1ce3b4 (after review round 9 and the parity fixes). Testbed: 83 tests; web benchmark `tests/`: 91 tests.

| Suite | PW chromium | BiDi chromium | PW firefox | BiDi firefox |
| --- | --- | --- | --- | --- |
| testbed | 82 pass, 1 skip | **82 pass, 1 skip** | 81 pass, 1 fail, 1 skip | 79 pass, 1 skip (3 left out, below) |
| web benchmark | 91 | **91** | 91 | 89, 2 fail |

CI runs the BiDi testbed on Chromium and Firefox in the spec gate (`.github/workflows/spec.yml`, job `bidi`), Firefox with the three tests below left out.

Every remaining failure, justified:

- **Playwright Firefox, raw mouse drag on the pad** (testbed): fails on `main` too (3 of 3 runs at 1d671f678); Firefox reports `y` 19 for a fractional box where Chromium reports 20. Not this branch.
- **BiDi Firefox, HTML5 drag and drop** (2 testbed, 2 benchmark): Firefox's remote agent ends the drag session on pointer up without synthesizing `drop` (its `EventUtils.js`: "TODO: This should synthesize drop"). `dragstart`, `dragenter`, `dragover` fire; `drop` and `dragend` never do. Same on stock Firefox 156, headed and headless, any move timing. Upstream: [bug 1515879](https://bugzilla.mozilla.org/show_bug.cgi?id=1515879) (NEW), fix path [bug 2051461](https://bugzilla.mozilla.org/show_bug.cgi?id=2051461) (ASSIGNED), [w3c/webdriver#1488](https://github.com/w3c/webdriver/issues/1488). Pointer-event drags (the kanban board) pass. A synthesized in-page `DragEvent` sequence would pass the tests with untrusted events, so it is left out.
- **BiDi Firefox, `browser.emulateMedia`** (1 testbed): Firefox 157 does not implement `emulation.setMediaFeaturesOverride`; `prefers-color-scheme` landed in Firefox 159 ([bug 2064354](https://bugzilla.mozilla.org/show_bug.cgi?id=2064354), meta [bug 2064352](https://bugzilla.mozilla.org/show_bug.cgi?id=2064352)). Configured `colorScheme` / `reducedMotion` apply as launch prefs; a mid-test change refuses with that reason.

## Parity with Playwright's own tests

`packages/web/tests/parity` (landed separately in #1505, on the Playwright driver): 33 of Playwright's `tests/page` specs (plus `library/download.spec.ts`) at v1.64.1, 511 tests rewritten against the public API, run on all four combos. Playwright driver results are the baseline; a BiDi-only failure is our bug unless Playwright's own BiDi expectations (`tests/bidi/expectations/*.txt`) or the protocol show a browser gap.

| Driver | Chromium | Firefox |
| --- | --- | --- |
| Playwright | 486 pass, 25 skip | 477 pass, 34 skip |
| BiDi | **473 pass, 38 skip** | **470 pass, 41 skip** |

No failures. Skips on both drivers are e2e gaps (`e2eGap`, listed in #1505) or Playwright's own platform skips. BiDi-only skips (`bidiGap`), each with its upstream reference:

- Chromium: `continueRequest` headers replace cookies; ACAO default, non-preflight OPTIONS, three CORS cases, unsafe header override; a child frame navigating its parent ("navigation canceled by concurrent navigation"); a frame rotated in 3D; Shift+Digit not shifted; navigation downloads reject with `net::ERR_ABORTED` before `downloadWillBegin`, so `goto` cannot say "Download is starting" (all listed in `bidi-chromium-page.txt` / `bidi-chromium-library.txt`); macOS editing key bindings (BiDi key actions carry no editing commands; macOS-only test).
- Firefox: fresh cookie from the store, both EventSource network-idle tests, folder upload, 3D frame (`moz-firefox-nightly-page.txt`); Shift+numpad reads NumLock off; Alt types the Option layer on macOS.
- Both: NumpadDecimal types "." (WebDriver numpad values are NumLock-on; Playwright's BiDi backend sends the same); media keys (WebDriver has no values; Playwright's BiDi backend throws "Unknown key").

BiDi bugs the suite found and fixed here: Playwright's text, label, role, and hidden rules in locate; `hasText` on the whole node text; aria checked/pressed/expanded tri-state; scrollIntoView for zero-size, `visibility: hidden`, `display: contents`, partly clipped, quirks-mode, and oversized elements (Chromium's center-if-needed); classic scrollbars on Firefox; caret hidden in every shadow root; Playwright's fill, select, check, and key error messages; numpad, located, and `\n`/`\r` keys, Enter's code; non-ASCII typed as text; CSS combinators across shadow roots; focus that does not land is no error; a page's own `Event` replaced; disabled options and optgroups; a swapped `<select>` re-resolved; header overrides with Playwright's forbidden list; redirect hops reusing the continued headers; CORS preflights answered while routing; fulfill with a reason phrase, ACAO, and bodies served back to response waits; URL hashes stripped; requests with no frame let through; "Invalid InterceptionId" after a cancel; EventSource out of network idle; upload validation (missing files, directories); a held Chromium navigation POST no longer hangs on its body (Chrome never answers it, as [puppeteer#15607](https://github.com/puppeteer/puppeteer/pull/15607) found over CDP); Firefox `goto` fails with "Download is starting".

## Methodology

- `node packages/web/bench/bidi.ts --iterations 20 --cold-iterations 10 --testbed-runs 3` after `pnpm build`. Raw numbers go to `bench/bidi-results.json` (gitignored).
- Drives the built `web()` engine through its contract hooks (`init`, `startAttempt`, `session.open`, `observe`, `locate`, `perform`, `keyboard`, `artifacts.screenshot`), the calls the runner and the agent loop make. No test runner in the scenario timings.
- Pages: the testbed app (`/forms`, `/scroll`, `/todos`) and a generated heavy page (1,500 table rows, ~9k elements), on localhost.
- Drivers interleave: cold iterations alternate driver order, warm iterations run in blocks of 5 per driver in alternating order, testbed runs alternate. A drift of the machine lands on both.
- Each ratio carries a bootstrap 95% interval (2,000 resamples, fixed seed).
- Equal work: every iteration's observed node counts of `/forms` and the heavy page must match across drivers, and every pixel observation must return pixels, or the run fails without a report.
- Agent flow: on `/todos`, open the page, then observe, find a node in the tree, and act, 7 times (3 fills, 3 taps on Add, 1 checkbox), with a final observation with pixels and the goal checked. Attempt setup is outside the timing.
- Memory: peak RSS of node plus every descendant during the warm loop (BiDi Chromium includes the mapper process). CPU: node `process.cpuUsage`, and node plus browser from `ps` (a floor: a renderer that exits between samples loses its last slice).
- Apple M5 Pro x15, 48 GB, macOS 27, Node 24.19.0, headless, 2026-11-01.

## Results

### chromium

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50, 95% CI) |
| --- | --- | --- | --- |
| cold launch (init) | 66.3 / 90.6 / 69.8 | 91.6 / 197 / 111 | 1.38x (1.20-1.74) |
| cold first page (startAttempt → open /forms → observe) | 57.2 / 73.8 / 58.5 | 52.4 / 78.2 / 57.7 | 0.92x (0.86-1.08) |
| new context + page (startAttempt → first open) | 39.7 / 46.5 / 40.4 | 36.7 / 40.8 / 37.0 | 0.92x (0.87-0.95) |
| navigate: testbed /forms | 7.4 / 8.1 / 7.6 | 6.7 / 7.3 / 6.7 | 0.90x (0.88-0.93) |
| observe: testbed /forms | 10.4 / 11.4 / 10.6 | 7.9 / 8.6 / 8.0 | 0.76x (0.74-0.78) |
| locate role+name: testbed /forms | 14.3 / 15.4 / 14.5 | 5.0 / 6.6 / 5.3 | 0.35x (0.34-0.37) |
| click/type sequence: forms (5 actions) | 109 / 125 / 112 | 71.6 / 87.7 / 76.8 | 0.66x (0.65-0.67) |
| screenshot: testbed /forms | 24.4 / 25.6 / 24.3 | 24.4 / 39.1 / 25.6 | 1.00x (0.99-1.01) |
| navigate: testbed /scroll (8k px) | 3.9 / 4.2 / 4.0 | 4.2 / 4.8 / 4.3 | 1.07x (1.04-1.09) |
| navigate: heavy page (9k elements) | 15.4 / 16.3 / 15.5 | 15.5 / 16.1 / 15.6 | 1.00x (0.99-1.02) |
| observe: heavy page | 163 / 175 / 165 | 174 / 183 / 176 | 1.07x (1.05-1.08) |
| observe + pixels: heavy page | 358 / 391 / 365 | 124 / 140 / 127 | 0.35x (0.33-0.36) |
| locate role+name: heavy page | 200 / 233 / 207 | 98.6 / 101 / 98.2 | 0.49x (0.45-0.52) |
| locate + fill + tap: heavy page | 76.8 / 83.7 / 76.9 | 39.7 / 44.6 / 40.0 | 0.52x (0.50-0.55) |
| screenshot: heavy page | 36.1 / 53.4 / 39.4 | 45.2 / 51.7 / 45.3 | 1.25x (1.21-1.31) |
| observe: /forms right after a heavy observation | 77.6 / 93.0 / 81.2 | 6.4 / 7.6 / 6.7 | 0.08x (0.08-0.09) |
| agent flow: todos (open, 7 actions, 8 observations) | 273 / 295 / 273 | 177 / 196 / 180 | 0.65x (0.64-0.71) |
| peak RSS, node + browser (MB) | 1405 | 1542 | |
| node CPU, warm loop (s) | 18.5 | 1.4 | |
| node + browser CPU, warm loop (s, floor) | 51.7 | 20.3 | |

### firefox

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50, 95% CI) |
| --- | --- | --- | --- |
| cold launch (init) | 314 / 324 / 316 | 925 / 960 / 929 | 2.95x (2.91-2.97) |
| cold first page (startAttempt → open /forms → observe) | 488 / 501 / 489 | 145 / 168 / 150 | 0.30x (0.29-0.32) |
| new context + page (startAttempt → first open) | 111 / 316 / 152 | 135 / 146 / 132 | 1.22x (1.08-1.27) |
| navigate: testbed /forms | 17.6 / 43.8 / 20.4 | 14.3 / 25.1 / 16.9 | 0.81x (0.77-1.12) |
| observe: testbed /forms | 12.7 / 34.6 / 17.6 | 11.5 / 27.2 / 13.2 | 0.91x (0.67-1.03) |
| locate role+name: testbed /forms | 18.2 / 23.7 / 19.9 | 7.3 / 7.9 / 6.4 | 0.40x (0.24-0.43) |
| click/type sequence: forms (5 actions) | 171 / 191 / 174 | 76.8 / 87.5 / 77.9 | 0.45x (0.44-0.46) |
| screenshot: testbed /forms | 14.1 / 19.0 / 15.4 | 12.1 / 17.4 / 13.2 | 0.86x (0.78-0.95) |
| navigate: testbed /scroll (8k px) | 6.5 / 8.0 / 6.7 | 8.0 / 9.2 / 8.0 | 1.23x (1.18-1.29) |
| navigate: heavy page (9k elements) | 50.5 / 54.1 / 51.3 | 51.3 / 54.9 / 51.6 | 1.02x (0.98-1.04) |
| observe: heavy page | 149 / 153 / 149 | 165 / 173 / 166 | 1.11x (1.10-1.12) |
| observe + pixels: heavy page | 471 / 496 / 478 | 110 / 116 / 111 | 0.23x (0.22-0.24) |
| locate role+name: heavy page | 178 / 195 / 180 | 110 / 116 / 111 | 0.62x (0.60-0.64) |
| locate + fill + tap: heavy page | 91.4 / 102 / 93.8 | 46.5 / 52.6 / 47.5 | 0.51x (0.49-0.52) |
| screenshot: heavy page | 27.1 / 31.4 / 28.0 | 20.7 / 28.7 / 22.3 | 0.77x (0.75-0.81) |
| observe: /forms right after a heavy observation | 83.5 / 86.5 / 83.5 | 8.3 / 10.1 / 9.0 | 0.10x (0.10-0.11) |
| agent flow: todos (open, 7 actions, 8 observations) | 418 / 458 / 421 | 269 / 293 / 271 | 0.64x (0.62-0.66) |
| peak RSS, node + browser (MB) | 2351 | 2644 | |
| node CPU, warm loop (s) | 18.0 | 2.4 | |
| node + browser CPU, warm loop (s, floor) | 77.7 | 33.7 | |

## Totals

| Total | playwright chromium | bidi chromium | playwright firefox | bidi firefox | BiDi vs PW chromium | BiDi vs PW firefox |
| --- | --- | --- | --- | --- | --- | --- |
| sum of p50s, every scenario (ms) | 1534 | 981 | 2623 | 2116 | -36% | -19% |
| sum of means, every scenario (ms) | 1566 | 1021 | 2697 | 2135 | -35% | -21% |
| realistic test: cold launch + new page + 6 agent steps (ms) | 334 | 274 | 768 | 1279 | -18% | +66% |
| testbed wall clock, median of 3 (ms) | 17525 | 16895 | 21102 | 20980 | -4% | -1% |
| node CPU, warm loop (s) | 18.5 | 1.4 | 18.0 | 2.4 | -92% | -87% |
| node + browser CPU, warm loop (s, floor) | 51.7 | 20.3 | 77.7 | 33.7 | -61% | -57% |
| peak RSS, node + browser (MB) | 1405 | 1542 | 2351 | 2644 | +10% | +12% |

- **Sum of p50s / means:** every scenario of the tables above added up, cold rows included.
- **Realistic test:** one cold launch, one new context and page, and N agent steps, with N = 6: the testbed averages 6.25 steps per test (79 tests, `.e2e/report.json`, median 5). An agent step is the agent flow's p50, less one navigation, over its 7 actions (each with the observation before it). Firefox's BiDi cold launch (~0.9 s, inherent to the Remote Agent, below) dominates its row: it is paid once per worker, not per test.
- **Testbed wall clock:** the whole testbed through the CLI, same machine, the testbed's own concurrency, median of 3 interleaved runs per driver. All 12 runs passed; on Firefox both drivers leave out the same 4 tests (BiDi's 3 upstream gaps and the pad drag Playwright's Firefox fails on main).
- **Overall:** on Chromium BiDi is 35-36% faster summed over scenarios, 18% faster on a realistic test, and 4% faster on the whole testbed, with 92% less node CPU and 10% more memory. On Firefox it is 19-21% faster summed over scenarios and level on the testbed (-1%), but 66% slower on a single realistic test because of the cold launch, with 12% more memory.
- **After the parity fixes** (30f1ce3b4) against the totals before them (c6fcde8f8): every total within noise or better (sum of p50s 974 → 981 ms Chromium, 2112 → 2116 ms Firefox; testbed 16885 → 16895 ms and 21036 → 20980 ms). The hit interceptor, Playwright-rule locate, and reader-based disabled check cost no measurable time.

## What changed since the first pass, and why

- **Locate on heavy pages: 3.5-4.7x slower → 1.3-2.4x faster.** The reader gained batched `roles`, `names`, and `nodes` modes (one setup per locate instead of per element), and the page prefilters candidates by role, name, attribute, and text as a superset before node reads.
- **Mapper unhandled rejection:** `CdpTargetManager` fires `Target.setAutoAttach` for tab targets in a `void (async () => …)()` with no catch; a tab closing mid-attach leaks a `CloseError` into whatever process hosts the mapper. It cannot be contained in-process without a global handler that would also swallow the harness's own reporting, so the mapper now runs in a child process that logs and survives it. Cost: cold launch 67 → 80 ms (it boots while Chrome starts); warm operations unchanged; worker node CPU 6.2 → 1.2 s.
- **Chromium memory:** the driver had launched with a startup tab (an extra renderer). With `--no-startup-window` and Playwright's disabled features, the browser holds 460 MB vs Playwright's 470 MB on the heavy page.
- **Firefox cold launch (~0.9 s vs 0.3 s):** Firefox's Remote Agent holds `session.new` until browser startup finishes (~800 ms after spawn: called 800 ms late it returns in 4 ms); Juggler does not wait. Startup prefs and a pre-warmed profile copy changed nothing. Paid once per worker.
- **Firefox memory (+150-180 MB):** one more content process than Juggler, for the startup window the Remote Agent opens (2 content processes before any attempt). Closing that window would quit Firefox on Linux and Windows, so it stays.
- **Shared remote browser:** intercepts are scoped to the attempt's tabs and prompts to its contexts; with several workers on one browser, global intercepts would hold other sessions' requests.

## Review rounds

Nine rounds of line-by-line review of the full diff (an independent reviewer model, read-only), each fixed in focused commits before the next:

| Round | Critical | Important | Nit | Resolution |
| --- | --- | --- | --- | --- |
| 1 | 38 | 15 | 1 | all fixed; 2 partly resolved by justification (intercept scope when attached over CDP, no main-vs-branch run for a same-build driver comparison) |
| 2 | 2 | 24 | 2 | all fixed |
| 3 | 0 | 15 | 1 | all fixed |
| 4 | 0 | 10 | 3 | all fixed |
| 5 | 0 | 6 | 0 | all fixed |
| 6 | 1 | 4 | 0 | all fixed and verified in both browsers |
| 7 | 0 | 7 | 0 | all fixed (slotted mask placement, mirrored slotted frames, cleanup that retires the browser, owned setup, bounded cookie writes, masks out of the tree, reader-based disabled check) |
| 8 | 0 | 8 | 1 | all fixed (disabled descendants retargeted, event-time hit interceptor, exact projected click point, containing-block clipping, fill/select without pointer stability, replacement intercepts owned, late setup cleanup, cancellation before cookie writes); benchmark refreshed |
| 9 | 0 | 7 | 0 | all fixed (unseen click may have committed, interceptor preloaded before app scripts, closed shadow roots, setup rejection observed at once, failed removals kept owed, user contexts retried, fixed elements clipped by a transformed containing block); the cap of 3 more rounds left no tenth review of these fixes |

What the rounds changed most: screenshot masking fails closed (top layer, page CSS, scaled dialogs, coverage proven after capture); retry safety (`ACTION_MAY_HAVE_COMMITTED` after any dispatch, cancellation checked before every dispatch); ownership of every browser-side resource (launches, user contexts, intercepts, collectors, preload scripts, ffmpeg, scratch tabs) through cancellation and cleanup; saved sessions with every origin's localStorage and IndexedDB; locator parity (labels, display values, shadow roots, frames, transforms).

## Verdict

**Faster on BiDi:**

- The agent step is 1.5-1.6x faster (agent flow p50 0.64-0.65x).
- Observing with pixels is 2.9-4.3x faster.
- Locate is 1.6-3x faster on small and heavy pages; locate plus actions about 1.9-2x.
- Summed over every scenario, 36% (Chromium) and 19% (Firefox) less time.
- Node CPU in the warm loop is 7-13x lower.

**Slower or heavier on BiDi:**

- Firefox cold launch is about 3x slower (925 vs 314 ms), inherent to the Remote Agent and paid once per worker.
- Chromium cold launch is +25 ms (the mapper process).
- Chromium full-viewport screenshots of the heavy page are 1.25x slower.
- 10-12% more peak memory.

**Worth switching?** On Chromium, plausibly: parity on both suites and on Playwright's own tests, a CI gate on the testbed and the parity suite, and a faster agent loop and testbed. Not yet the default, because:

- the persistent remote context mode is not built;
- a few documented limits remain (Playwright selector chains, rotated or mirrored frames, the BiDi-only parity skips above);
- Firefox waits on two upstream items (HTML5 drag-and-drop, media emulation in 159).

Next steps: run BiDi Chromium beside Playwright in CI for a while, build the persistent context mode, then decide on the default.
