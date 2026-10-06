# @e2e-dev/web

## 0.13.0

### Minor Changes

- [#790](https://github.com/tester-army/e2e/pull/790) [`0d1ed15`](https://github.com/tester-army/e2e/commit/0d1ed15871674aafd0ee3eff92c17eb39f6012bd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - **Breaking: e2e and every `@e2e-dev` package now need Node.js 22.22.3 or newer on Node.js 22, or 24.8.0 or newer** (`engines.node` is `^22.22.3 || >=24.8.0`). Node.js 22.12 through 22.22.2, 23, and 24.0 through 24.7 are no longer supported, and the CLI refuses to start on them, naming the versions to upgrade to. Those releases fail when a CommonJS file a test imports requires TypeScript through the new loader's `module.registerHooks` (nodejs/node#59679 fixed it in 22.22.3 and 24.8.0).
  
  e2e now loads TypeScript with its own loader, built on oxc, instead of tsx. tsx brought in esbuild, whose postinstall script made every `pnpm install` on pnpm 11 and later fail with `ERR_PNPM_IGNORED_BUILDS` until the project approved the build; nothing e2e installs runs an install script now. Config and tests load as before: ESM whatever `package.json` says, `./x.js` and `./x` resolve to `x.ts` and `./x.jsx` to `x.tsx`, directory index imports, tsconfig `paths` and `baseUrl`, workspace packages exporting `.ts` source, JSX in `.tsx` and `.jsx`, enums, namespaces, `experimentalDecorators`, and source-mapped stack traces. JSON imported without `with { type: 'json' }` still loads. A test file whose name holds `%`, `#`, or a space now collects with its source location instead of failing with "URI malformed" or losing the location. Each file reads its nearest `tsconfig.json` rather than the one in the working directory. What changes: `import` statements in a `.cts` file are no longer compiled into `require` calls (write `import x = require()`); standard decorators without `experimentalDecorators`, auto-accessors, and ES module `import` and value `export` declarations in `.cts` are refused with their line (`import type`, `export type`, `import x = require()`, and `export =` work); the CLI refuses the Bun (`bun --bun`) and Deno runtimes (install with any package manager, run on Node.js); a type imported without `import type` that stays in the output (a decorated member's type under `emitDecoratorMetadata`) fails to load, with an error naming the import; a `.ts` file a CommonJS file requires runs as an ES module like every other `.ts`, so one written with `module.exports` needs the `.cts` extension; and an import written in a JavaScript file resolves as Node.js resolves it, without TypeScript's extension rules or tsconfig `paths`. TypeScript inside an installed package compiles without the project's `tsconfig.json`.

- [#840](https://github.com/tester-army/e2e/pull/840) [`b33398f`](https://github.com/tester-army/e2e/commit/b33398fc380a1ecd8a0784d1c5c2fcbdeefaf841) Thanks [@Mohit20057](https://github.com/Mohit20057)! - `screen.swipe({ from, to, duration })` adds an optional `duration` for path swipes, controlling how long the gesture takes in milliseconds.

### Patch Changes

- [#803](https://github.com/tester-army/e2e/pull/803) [`f2f9a53`](https://github.com/tester-army/e2e/commit/f2f9a5373d520c35514da713c3f0c18a343b96ff) Thanks [@fecolinhares](https://github.com/fecolinhares)! - A headless run no longer downloads the full Chromium when the headless shell is installed, and the install no longer removes other browsers in the cache. Set `PLAYWRIGHT_SKIP_BROWSER_GC=0` to restore cleanup.

- [#860](https://github.com/tester-army/e2e/pull/860) [`60bf04d`](https://github.com/tester-army/e2e/commit/60bf04d576df1619854a91fd424f22f52e5d8441) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `browser.evaluate` evaluates a string as an expression: `browser.evaluate('document.title')` and `browser.evaluate('(() => document.title)()')` return the title instead of failing with `EVALUATE_FAILED: ... is not a function`. A string that evaluates to a function, such as `'() => document.title'`, is still called with the argument.

- [#859](https://github.com/tester-army/e2e/pull/859) [`432e9bf`](https://github.com/tester-army/e2e/commit/432e9bff7c7d6f97b37412e1f4d1f3053057fb15) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An action whose locator gains a second match just before it runs, such as a screen transition that briefly shows the old and new page together, no longer fails with `ENGINE_FAILURE` and a Playwright strict mode violation. The locator resolves again: two matches still fail with `LOCATOR_AMBIGUOUS`, and a duplicate that went away lets the action run. A drag whose drop target gains a second match after the press fails with `ACTION_FAILED` and is not repeated.

- [#891](https://github.com/tester-army/e2e/pull/891) [`a0e5142`](https://github.com/tester-army/e2e/commit/a0e5142f619916a3d9648653f295600ab2f8b5dc) Thanks [@rudycelekli](https://github.com/rudycelekli)! - Infer scope-less table headers from neighboring data cells, matching native row headers in semantic observations.

- [#828](https://github.com/tester-army/e2e/pull/828) [`c83b86f`](https://github.com/tester-army/e2e/commit/c83b86f4917d41cf5cf5941d909fb5f087916b88) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A page whose script never yields no longer holds a web test until its test timeout: a tap, a locate, or a navigation on it now fails with `ACTION_FAILED` at its action or navigation timeout, also while a trace records. A tap or keystroke cut off that way may have reached the page and is never repeated by a replay. `expect(browser)` matchers on such a page end at their own timeout instead of the action timeout.

- [#913](https://github.com/tester-army/e2e/pull/913) [`7c158ee`](https://github.com/tester-army/e2e/commit/7c158ee63761248180e2a97a00d2e6d5583ba374) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Requires `e2e` 0.18.0 or later. With an older runner the engine failed to load, or a headed run failed to launch the browser.

## 0.12.0

### Minor Changes

- [#798](https://github.com/tester-army/e2e/pull/798) [`02ad48a`](https://github.com/tester-army/e2e/commit/02ad48a94ef9f68befc89139694c519868d82853) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `@e2e-dev/web` depends on `playwright-core` pinned to an exact version instead of peering on `playwright`. Projects no longer install Playwright themselves, and the engine always runs the Playwright it was tested against. Remove `playwright` from your dependencies unless your app uses it for its own tests:
  
  ```bash
  npm uninstall playwright
  ```
  
  Install browsers in CI with the package's new command, which runs the engine's Playwright: `npx @e2e-dev/web install chromium --with-deps` (`pnpm exec e2e-web install chromium --with-deps` under pnpm) replaces `npx playwright install chromium --with-deps`. Open traces with `npx playwright-core@1.63.0 show-trace <file>` (`pnpm dlx` in a pnpm project). An app that also depends on `@playwright/test` keeps its own copy; the two share a browser cache only when their versions match. `e2e init` no longer adds `playwright` to a new project.

- [#795](https://github.com/tester-army/e2e/pull/795) [`3b026fa`](https://github.com/tester-army/e2e/commit/3b026fa81bc0b6eb896d2e44a98c17f6e54063b4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Init scripts, like Playwright's `addInitScript`: `web({ initScripts })` for every test, `browser.addInitScript(script, arg?)` for one. A script is source, a `{ path }`, or a function.

- [#786](https://github.com/tester-army/e2e/pull/786) [`f88233f`](https://github.com/tester-army/e2e/commit/f88233fdce99ba57420e5f8d5c80e9254332f4d5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - web({ locale, timezoneId }) sets the language and time zone every attempt's context runs in, as Playwright's `use.locale` and `use.timezoneId` do: `navigator.language`, `Intl`, the `Accept-Language` header, and local `Date` time. A tag `Intl` rejects is `INVALID_CONFIG` at config load, and so is an `accept-language` entry in `headers` beside `locale`, and either option on a persistent remote context (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`).

### Patch Changes

- [#788](https://github.com/tester-army/e2e/pull/788) [`baa32c6`](https://github.com/tester-army/e2e/commit/baa32c68013215a62c31c25238926d4ee4300ada) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `check()` and `uncheck()`, and the agent's `check` tool, pass when the click removes the control or navigates away from it, such as a radio the app replaces with its selected view. The click landed, so the action is recorded and replays. What replaced the control is not read, so a test that needs it asserts on it. They used to fail: an agent step reported `LOCATOR_NOT_FOUND` and left the action out of its recording, so the next run handed off with `end-mismatch`, and a locator `check()` timed out. Unchecking a checked radio and a click that leaves the state unchanged now fail with `NOT_ACTIONABLE` instead of `ENGINE_FAILURE`.

- [#726](https://github.com/tester-army/e2e/pull/726) [`f7c0756`](https://github.com/tester-army/e2e/commit/f7c075666672d128f79ef2ec347fda67ea9e42ce) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `locator.waitFor` adds Playwright's `attached` and `detached` states and refuses any other state, or an option key besides `state` and `timeout`, with `INVALID_ARGUMENT`. Before, every state but `visible` ran as `hidden`, so `waitFor({ state: 'attached' })` and a misspelled state passed at once on an absent node. `toBeHidden`, `toBeVisible({ visible: false })`, `toBeAttached({ attached: false })`, and `waitFor` `detached` and `hidden` read a locator under a frame missing from the document as zero matches instead of timing out waiting for the frame. `toHaveProperty` reads a primitive on the path through its wrapper, as Jest does, so `toHaveProperty('label.length', 3)` passes. `expect(browser).toHaveURL` takes `ignoreCase`, and `urlMatches` in `e2e/engine` takes it as an optional fourth argument.

- [#722](https://github.com/tester-army/e2e/pull/722) [`f0f9c8d`](https://github.com/tester-army/e2e/commit/f0f9c8daaefd8751045e540007a09ba830147d48) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Explicit navigation now uses an allowlist instead of a denylist: `app.open`, `browser.goto`, and the agent's `navigate` verb admit `http:`, `https:`, and the exact `about:blank`, and every other scheme (`chrome:`, `blob:`, `about:srcdoc`, ...) is `POLICY_DENIED`. A wrapped scheme such as `view-source:file:///...` no longer loads a local file; it is `POLICY_DENIED` like `file:` itself. `device.openLink` and `device.openApp` also refuse `view-source:`, `blob:`, and `filesystem:` links. `browser.setCookies` refuses an `about:blank` cookie URL with `POLICY_DENIED`.

- [#785](https://github.com/tester-army/e2e/pull/785) [`9844c30`](https://github.com/tester-army/e2e/commit/9844c30d1d320eecf51446f0100853d7310c564d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A string role name with a quote (`getByRole('button', { name: "Yes, I'm sure" })`) no longer fails with `InvalidSelectorError` once the locator is chained (`.first()`, `nth`, a filter, or the read itself). The same goes for a `u` or `v` flag RegExp with a quote or `>>` in `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, and `getByTestId`.

- [#723](https://github.com/tester-army/e2e/pull/723) [`cdc3a53`](https://github.com/tester-army/e2e/commit/cdc3a53e816bcb8a5d8a4beb934b06b293d8c358) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Route decisions behave like Playwright's. `route.continue()` now sends the request to the network instead of handing it to an earlier route, and still carries the configured `headers` to the app's site; the new `route.fallback()` keeps the old chaining. `continue` takes `url`, `method`, `headers`, and `postData`, with `url` checked by the same rule as `goto`, and `fulfill` takes `path` (relative to the project root) and `contentType`. An option a decision does not take, such as `abort(errorCode)` or a misspelled key, is `INVALID_ARGUMENT` instead of being ignored. `browser.waitForResponse` resolves once a matching response's headers arrive, so a slow body no longer fails the match with a timeout; `text()` and `json()` wait for the body up to the action timeout. `browser.setCookies` with a relative `url` sets the cookie on the base URL instead of failing with `ENGINE_FAILURE`.

- [#728](https://github.com/tester-army/e2e/pull/728) [`7f9ee10`](https://github.com/tester-army/e2e/commit/7f9ee108dbdcbfab43cff2cdd9435b043a7035d1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Web visibility and reads follow what renders, as Playwright reads them: an `aria-hidden` node that paints is visible, so `toBeHidden()` on a decorative spinner waits until it leaves; content under `content-visibility: hidden` is hidden; a child that sets `visibility: visible` under a hidden parent is visible and in the agent's observation; text under a `display: contents` element with `visibility: hidden` is hidden, where Playwright calls it visible, since it paints nothing. `boundingBox()` is `null` for a node with no layout box. `inputValue()` and `toHaveValue` read a checkbox's or radio's value (`on` by default) whatever its checked state. An accessible name reads an embedded control's value: `<button>Flash the screen <input value="3"> times</button>` is "Flash the screen 3 times".

## 0.11.2

### Patch Changes

- [#748](https://github.com/tester-army/e2e/pull/748) [`8415579`](https://github.com/tester-army/e2e/commit/84155791f7bc970ac3eb74d1d6f59e9c54a6e5c4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A locator whose match the page replaces on every animation frame (a field re-rendered each frame) no longer fails with `LOCATOR_NOT_FOUND` "node became stale" on a loaded machine. Locate read each match in a protocol call after the one that found it, so when a frame passed between the two, which a busy runner makes likely every time, the read found the match detached and the locate retried until the action timeout. Each match is now read in the same in-page task that finds it, so the read never sees a replaced element. A `getByLabel` or `getByDisplayValue` match is still pinned to the element that was read.
  
  A `browser.locator` selector with a `*` capture before its last part (`*css=article >> text=Hello`) now fails with `INVALID_LOCATOR` instead of resolving; use `filter({ has })`. A capture rewrites the chain so the elements it returns are never the ones the rest of the locate reads, and composing anything onto such a selector already matched the captured element instead of its descendants.

- [#763](https://github.com/tester-army/e2e/pull/763) [`b573756`](https://github.com/tester-army/e2e/commit/b573756818d7d04088142d29e0e730cfbaf21b45) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Installing `e2e` pulls in 29 packages instead of 117 and takes about 31MB instead of 36MB. `e2e mcp` now runs on the split MCP SDK (`@modelcontextprotocol/server` 2.2.0) in place of `@modelcontextprotocol/sdk`, which brought in express, hono, and the rest of an HTTP server stack that stdio never used. The server keeps the same protocol version, so existing clients connect as before. Packages are built and published without sourcemaps, which pointed at a `src/` that was never shipped. Stack traces show `dist/` positions.

- [#770](https://github.com/tester-army/e2e/pull/770) [`7fd610b`](https://github.com/tester-army/e2e/commit/7fd610b0c22b58ddbb0c08557685e3a677dd3ba7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The web semantic tree lists an inline `<svg>` as an `image`, named by its `<title>` child, as Playwright's `getByRole('img')` and aria snapshot read it. An icon-only control built from an unnamed wrapper and an svg no longer disappears from what the agent sees.

- [#579](https://github.com/tester-army/e2e/pull/579) [`c6c39ad`](https://github.com/tester-army/e2e/commit/c6c39ad3f631cc0a29d788af7d8e6b798ef5307c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `expect(browser).toHaveURL`, `toHaveTitle`, `toHaveClass`, and `browser.waitForURL` refuse an option other than `timeout` with `INVALID_ARGUMENT` instead of ignoring it, so Playwright's `ignoreCase` on `toHaveURL` or `waitUntil` on `waitForURL` no longer runs as if absent.

## 0.11.1

### Patch Changes

- [#706](https://github.com/tester-army/e2e/pull/706) [`1a80c23`](https://github.com/tester-army/e2e/commit/1a80c23d8789382847aa78fb5325ecc1281c3b6a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - npm package pages: `e2e` ships the repository README, and every package has keywords people search for.

## 0.11.0

### Minor Changes

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: the web engine's fixture is `browser`, not `web`: `test('...', async ({ screen, browser }) => { await browser.goto('/') })`, `expect(browser).toHaveURL('/')`, and `requires: ['browser']`. The `Web` type is now `Browser` and `WebExpectation` is `BrowserExpectation`; the `web()` engine factory and the network and option types (`WebRoute`, `WebResponse`, `WebOptions`) keep their names. Recorded steps read `browser.goto` and the rest. A leftover `requires: ['web']` skips the test on every web target: rename it to `requires: ['browser']`.

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `describe`, `beforeEach`, `afterEach`, `beforeAll`, and `afterAll` are top-level exports of `e2e`, the same functions as `test.describe` and the `test.*` hooks: `import { describe, beforeEach, test } from 'e2e'`. `@e2e-dev/web` and `@e2e-dev/mobile` export `describe` and all four hooks beside `test`, typed with their `browser` or `device` fixture, so a test file registers from one import. `test.describe` and the `test.*` hooks stay, and are how a `test.extend()` chain registers hooks that see its fixtures.

- [#698](https://github.com/tester-army/e2e/pull/698) [`4d488f8`](https://github.com/tester-army/e2e/commit/4d488f828695998275590e5da9aa5be77b8cf726) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `web()` only drives the browser. The app it opens is the target's: `web({ url, environment, identity, command, readyUrl })` becomes `targets: [{ engine: web(), app: { url, ... } }]`, and `web({ services })` is gone with them; every old option is an unknown key, `INVALID_CONFIG`. A `web()` target needs `app.url` and refuses the device fields (`bundleId`, `appPath`, `launchArguments`, `permissions`). A target with `app.url` is a `browser` target, so a test can require one with `requires: ['browser']`.

### Patch Changes

- [#662](https://github.com/tester-army/e2e/pull/662) [`10d392e`](https://github.com/tester-army/e2e/commit/10d392ea3ceb34c96ca1735812d60701c7830557) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A secret an engine option holds (`web({ basicAuth: { password: secrets.get(name) } })`) now has its text downloads rewritten through the redactor too, as its trace already was, and the web engine registers the base64 `user:password` credential of the `Authorization` header for redaction, so a page that echoes its request headers shows `Basic <secret:name>` in the report, `screen.txt`, the failure pages, the trace, what the model reads, and `e2e mcp` observations. The protection is text only: screenshots, the trace's screencast frames, and the model's pixels are kept as with no secret, so a page that renders the basic-auth password on screen is not masked in pixels. Engines pass such derived forms through the new `resolveSecret(secret, { derived })` option.

- [#669](https://github.com/tester-army/e2e/pull/669) [`f5bc45a`](https://github.com/tester-army/e2e/commit/f5bc45ac145718ec82396f28339d479c48d66612) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Names read CSS generated content, as the browser and `getByRole` do, and drop icon-font glyphs. A Font Awesome button, `<button><i class="fa fa-sign-in"> Login</i></button>`, is `button "Login"` on screen and `getByRole('button', { name: 'Login' })` finds it, where it used to find nothing; a `.next::before { content: "→" }` icon reads `button "→ Next"` in both. A glyph between two words reads as a space, and a control whose only content is a glyph reads as its `title`, though the browser names it by the glyph, so a role query by that title still finds nothing.

- [#669](https://github.com/tester-army/e2e/pull/669) [`f5bc45a`](https://github.com/tester-army/e2e/commit/f5bc45ac145718ec82396f28339d479c48d66612) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The limits of a persistent browser context fail early and name their cause. `app.clearState()` with `kernel({ scope: 'attempt' })`, any provider with `scope: 'attempt'`, or `connect.reconnectEndpoint` fails with `UNSUPPORTED_CAPABILITY` naming that mode, instead of `engine web does not implement it`. A run whose tests consume a session on a target whose engine has no state capability fails with `COLLECTION_ERROR` before any test, instead of failing at `session.save()` after the setup test logged in.

- [#669](https://github.com/tester-army/e2e/pull/669) [`f5bc45a`](https://github.com/tester-army/e2e/commit/f5bc45ac145718ec82396f28339d479c48d66612) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `browser.waitForDownload` works on a Kernel browser. It failed with `download failed: download.saveAs: canceled` on every hosted browser, which saves a download to its own disk. A `BrowserProvider` can now implement `downloads: { dir, read }`: the engine has the browser save under `dir` on its machine and reads the finished file back through `read`. `kernel()` implements it with Kernel's browser filesystem API. On a provider without it, a failed download names the provider and the missing `downloads`.

- [#669](https://github.com/tester-army/e2e/pull/669) [`f5bc45a`](https://github.com/tester-army/e2e/commit/f5bc45ac145718ec82396f28339d479c48d66612) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A worker that dies no longer leaks its Kernel browser. With `kernel({ scope: 'attempt' })`, a crashed or killed worker left its attempt's browser running until Kernel's `timeout_seconds`, ten minutes by default; a replacement a worker leased in `worker` scope leaked the same way. A `BrowserProvider` can now implement `sweep(context)`, which the engine calls once per target when the run ends to release the run's leases a worker left open, and `kernel()` deletes every browser still active with the run's `e2e_run` and `e2e_target` tags. The reporter names each browser it released.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Unknown keys are rejected below the top level of the config too, naming the nearest known key when one is a plausible typo and the known keys otherwise. `app: { url, comand }` on a target is `INVALID_CONFIG` (the run used to go on and fail with `APP_UNREACHABLE`), and so are an unknown `web()` or `mobile()` option, an unknown key inside `connect` or `basicAuth`, and an unknown key in `app.command` (`command: { executable, arg }` dropped the arguments). An unknown test or `describe` option (`{ timout }`) is `COLLECTION_ERROR`, and an unknown query option (`getByRole('link', { nam })`) is `INVALID_LOCATOR` listing the keys the query takes. `e2e/engine` exports `rejectUnknownKeys(label, value, keys)`, the same check for an engine's own options.

- [#664](https://github.com/tester-army/e2e/pull/664) [`f67c49a`](https://github.com/tester-army/e2e/commit/f67c49a3556616fd55250a017de6673af8d8c0c1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A terminal Ctrl-C no longer kills a web worker mid-test. Playwright's own SIGINT and SIGTERM handlers are off, so the runner's interrupt ends the running test as `interrupted` with its attempt, runs its `afterEach` hooks, and disposes the browser, instead of the worker exiting 130 with `WORKER_EXIT` and the test reported `skipped`.

- [#669](https://github.com/tester-army/e2e/pull/669) [`f5bc45a`](https://github.com/tester-army/e2e/commit/f5bc45ac145718ec82396f28339d479c48d66612) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A browser provider's progress lines reach the reporter from a worker too. Kernel's `browser <id>, watch at <live view URL>` line was dropped for every browser in `scope: 'attempt'` and for a replacement after a browser dropped; it now shows, prefixed with the target and worker slot.

## 0.11.0-canary-20260929180659

### Minor Changes

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web({ basicAuth: { username, password } })` takes `password: secrets.get(name)` for a `secrets` entry. The engine resolves it when each attempt starts, so a provider can rotate it, and the runner redacts the value from reports, logs, what the agent reads, and the Playwright trace, which records the context's credentials, like any configured secret.

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `web({ video: { size, quality } })` is now `web({ screencast: { size, quality } })`, and the `WebVideoOptions` type is `WebScreencastOptions`. The options shape the page screencast; which attempts record is still the `video` mode on the config or a target. A config that still passes `web({ video })` fails with `INVALID_CONFIG` naming `screencast`.

- [#626](https://github.com/tester-army/e2e/pull/626) [`636acd9`](https://github.com/tester-army/e2e/commit/636acd901f03dbff9e657dcce10d98634f88a1ab) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The browser engine declares `tapModifiers` and holds the modifiers of `tap`, `doubleTap`, and `secondaryTap` for the click.

- [#613](https://github.com/tester-army/e2e/pull/613) [`c5363ed`](https://github.com/tester-army/e2e/commit/c5363ed5f9ca521312803e0b919db09113fb9bf3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - web({ userAgent }) sets the `User-Agent` every attempt's context sends and `navigator.userAgent` reports, as Playwright's `use.userAgent` does, for an app that switches into a test mode on a marker in the agent string. A persistent remote context (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`) rejects it with `INVALID_CONFIG`, like `headers` and `basicAuth`, and so does a `user-agent` entry in `headers` beside it.

- [#610](https://github.com/tester-army/e2e/pull/610) [`aadcb5d`](https://github.com/tester-army/e2e/commit/aadcb5dddb79217608a88c75af6cc4e5a582c592) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A browser provider can record the attempts it serves: `BrowserProvider.record(lease, context)` starts the service's own recording of the leased browser (the whole window, tabs and address bar) once the attempt's page is open, and its file or link becomes the attempt's video in place of the page screencast. A provider that cannot record leaves `record` out. `web({ screencast: { size, quality } })` sets the screencast's frame size and JPEG quality.

### Patch Changes

- [#618](https://github.com/tester-army/e2e/pull/618) [`fd10bf5`](https://github.com/tester-army/e2e/commit/fd10bf57d73bb54fc6189437394ba347cc813086) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An action that times out waiting to become actionable reports Playwright's headline and the last blocker its call log names, such as `<div data-popover>… intercepts pointer events`, instead of the whole log repeated once per retry. The agent read that log as model input, several thousand characters per blocked tap.

- [#622](https://github.com/tester-army/e2e/pull/622) [`5ba259d`](https://github.com/tester-army/e2e/commit/5ba259d7a634bf5dedfb51342e9a95fc4088b9b5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `web.waitForDownload` whose trigger resolved but started no download fails with `no download started within <n>ms; the trigger resolved after <m>ms` instead of `operation timed out in web.waitForDownload`.

- [#640](https://github.com/tester-army/e2e/pull/640) [`97a7e7f`](https://github.com/tester-army/e2e/commit/97a7e7f12129b029d53f28458c2a7ea72c083ea4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Agent and MCP observations show a link's whole target. The web engine cut `href` at 80 characters with no marker, so a link to `/projects/<uuid>` read as one to a truncated id. A target on the app URL's origin now renders as its path, complete and shorter than the URL, and any other keeps its origin; a dropped query or fragment shows as `?…` or `#…`, a `data:` or `javascript:` payload as `data:…` or `javascript:…`, and a target past 256 characters ends with `…`, in the line the model reads and the tree a custom executor gets. `mailto:`, `tel:`, and `blob:` links keep their scheme.

- [#614](https://github.com/tester-army/e2e/pull/614) [`62a691d`](https://github.com/tester-army/e2e/commit/62a691d17850c39cfad99cb8ba05ea4ede3ced3d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A control named only by a descendant's `title`, or by an `aria-labelledby` target holding only whitespace, is named the way `getByRole` matches it. The tree fell back to the title whenever the content trimmed to nothing, while Playwright keeps the untrimmed content, so `<button><div title="Next month" style="display:flex"><svg/></div></button>` read as button "Next month" in the tree and in failure hints but `getByRole('button', { name: 'Next month' })` matched nothing.

- [#611](https://github.com/tester-army/e2e/pull/611) [`fa9ca38`](https://github.com/tester-army/e2e/commit/fa9ca383dab8b46f13e4cc9d2db27a845d7c5e2f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A video started while a trace is already running fills the viewport. The trace sized the page's screencast for itself first, so the video came out at the trace's size, padded with grey. The running trace is now split around the start: its segment so far is saved and it resumes on the video's screencast, also when the video fails to start.

- [#625](https://github.com/tester-army/e2e/pull/625) [`43769a2`](https://github.com/tester-army/e2e/commit/43769a2dc4eedcd675e5a8abaf4697c17903cd7a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web.setViewport` works before the first navigation, as Playwright's `setViewportSize` does, instead of failing with `APP_NOT_OPEN`. The next `app.open` loads at that size, so a phone-sized test never renders the desktop layout first. The size also holds through `app.restart()` and `app.clearState()`.

- [#596](https://github.com/tester-army/e2e/pull/596) [`d27ade8`](https://github.com/tester-army/e2e/commit/d27ade84ef1ff82d64d63cacce3f7437b9214bf9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A provider with `scope: 'attempt'` no longer fails an attempt at random with `cdpEndpoint reused a browser from a previous attempt`. A service that restores browsers from one snapshot (Kernel does) hands out new browsers whose default context has an earlier one's id; a lease is fresh by the provider's contract, so the engine checks earlier contexts only for `connect.reconnectEndpoint`. The attempt's first page is now the browser's own first tab, navigated to `about:blank`, instead of a second tab beside it, so a hosted browser's live view shows one tab.
- Updated dependencies [[`d228e22`](https://github.com/tester-army/e2e/commit/d228e22ea309107cd42283bcfcb5f614ca3ea8c6), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`12fe125`](https://github.com/tester-army/e2e/commit/12fe12550d37cfefe36b65a30d53ae4eb024d641), [`8a65a90`](https://github.com/tester-army/e2e/commit/8a65a9093d75a9e819bfc610cd7ebaf8055497a6), [`0cb74d6`](https://github.com/tester-army/e2e/commit/0cb74d6d916e62c38aeb05ce97658d3c67468843), [`425fd67`](https://github.com/tester-army/e2e/commit/425fd6765738da199a8dfbafa2d072294dd81822), [`ec1ea1e`](https://github.com/tester-army/e2e/commit/ec1ea1e4c3142661897e0c23654e0aba2c43dbaa), [`04a1261`](https://github.com/tester-army/e2e/commit/04a126191eb9fefc730b93cd249f7c152e0166d1), [`968b055`](https://github.com/tester-army/e2e/commit/968b05545db8c961bf864bcb2aa3fdfd59c626f8), [`97a7e7f`](https://github.com/tester-army/e2e/commit/97a7e7f12129b029d53f28458c2a7ea72c083ea4), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`636acd9`](https://github.com/tester-army/e2e/commit/636acd901f03dbff9e657dcce10d98634f88a1ab), [`a411ac6`](https://github.com/tester-army/e2e/commit/a411ac65245fd3602acc731a051e9726f75756aa), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`aadcb5d`](https://github.com/tester-army/e2e/commit/aadcb5dddb79217608a88c75af6cc4e5a582c592), [`85a3afd`](https://github.com/tester-army/e2e/commit/85a3afd7c41b6b28af84bd3182671fabaeec871e), [`ba0d280`](https://github.com/tester-army/e2e/commit/ba0d2804194d8985beb0760ab1fa1e9e945b6aaa)]:
  - e2e@0.15.0-canary-20260929180659

## 0.11.0-canary-20260928184528

### Minor Changes

- [#602](https://github.com/tester-army/e2e/pull/602) [`67c29fc`](https://github.com/tester-army/e2e/commit/67c29fc6b207822c9525360e6bf9c3130411a947) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engines and the reporter publish under the `@e2e-dev` scope: `@e2edev/web` is `@e2e-dev/web`, `@e2edev/mobile` is `@e2e-dev/mobile`, and `@e2edev/github` is `@e2e-dev/github`. The `@e2edev` packages get no new releases. To move, swap the dependencies (`npm uninstall @e2edev/web && npm install --save-dev @e2e-dev/web`) and rewrite the imports: `from '@e2edev/web'` becomes `from '@e2e-dev/web'`, and the same for `@e2edev/mobile`, `@e2edev/mobile/tools`, and `@e2edev/github`. `e2e init` installs and imports the new names.

- [#542](https://github.com/tester-army/e2e/pull/542) [`166f279`](https://github.com/tester-army/e2e/commit/166f279b9778b0a01bd4cefb70c22e38787ea0a7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web({ viewport: null })` emulates no page size: the page fills the browser window, and observations, screenshots, swipes, and the video recording use the window's size, measured in the page. For a headed run or a hosted browser whose live view shows the whole window, where the fixed 1280 by 720 default renders in one corner of it. `web.setViewport` still fixes a size for the rest of the attempt.

### Patch Changes

- [#545](https://github.com/tester-army/e2e/pull/545) [`f9f49f4`](https://github.com/tester-army/e2e/commit/f9f49f41ef521fd712db340ab291afa58e259ec6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getAttribute` and `toHaveAttribute` only answer attributes the element carries. The attribute map reached both as a plain object and was read by name alone, so an attribute named like an `Object.prototype` member leaked the member: `expect(button).toHaveAttribute('constructor')` passed on a button with no such attribute, `.not.toHaveAttribute('constructor')` failed with `attribute "constructor" undefined`, and `getAttribute('constructor')` handed back a function instead of `null`. Every read now goes through one own-property lookup, an absent attribute is `null` whatever its name, and a real `constructor="x"` attribute still reads as its string. The web engine builds the map without a prototype for the same reason.

- [#584](https://github.com/tester-army/e2e/pull/584) [`14fde0b`](https://github.com/tester-army/e2e/commit/14fde0b833c4fbee53a37f5d8131e107525dd126) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A file input reads as `button`, the role Chrome and Playwright give it, instead of `textbox`. `getByRole('button', { name })` finds it, and the agent no longer treats it as a field it could type into or fill with a secret. A committed trace-cache recording that uploads through `textbox "<name>"` stops replaying and hands the step to the agent; re-record it.

- [#585](https://github.com/tester-army/e2e/pull/585) [`dac7b82`](https://github.com/tester-army/e2e/commit/dac7b82e87971472816cd00b25a5fe3972f53a1c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An `inert` subtree leaves the tree the agent sees, as Chrome's accessibility tree drops it. Its controls take no input, so listing them let the agent aim at a button that ignores every action. Locators and `toBeVisible` read inert content as before.

- [#592](https://github.com/tester-army/e2e/pull/592) [`8e105fc`](https://github.com/tester-army/e2e/commit/8e105fcb44e02d48d587610e845829e28935928a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `<header>` or `<footer>` inside an element with a sectioning role (`role="article"`, `complementary`, `main`, `navigation`, or `region`) is no longer a page `banner` or `contentinfo` landmark, as inside an `<article>` or `<section>`, which is how HTML-AAM and Playwright's `getByRole` read it.

- [#571](https://github.com/tester-army/e2e/pull/571) [`93b45b7`](https://github.com/tester-army/e2e/commit/93b45b79c77ae78a9069e6442df51413771fc3bd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A URL or text pattern that is neither a string nor a `RegExp` is `INVALID_ARGUMENT`. Before, a Playwright-style predicate read as a regexp with no source, which matches everything: `expect(web).toHaveURL(url => ...)` passed on any page, `web.waitForURL(fn)` resolved at once, `web.waitForResponse(fn)` returned the first response of any kind, `web.route(fn, handler)` intercepted every request, the document included, and `expect(value).toMatch(fn)` passed on any string. A text matcher or query given one, such as `toHaveTitle(fn)` or `getByText(fn)`, threw a raw `TypeError`. `toTextPattern` and `urlMatches` in `e2e/engine` throw the same error, so an engine that uses them refuses such a pattern too. A `RegExp` from another realm is still a `RegExp`.

- [#553](https://github.com/tester-army/e2e/pull/553) [`e72752f`](https://github.com/tester-army/e2e/commit/e72752fb6199a8b56370ea3c66f5ce02b746193d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The reader names every role accname names from content: a `<div role="checkbox">`, `role="radio"`, or `role="switch"` reads its text, a table cell, gridcell, row, or header reads its content, and a custom element with `role="button"` reads the text behind its shadow root, slots resolved the way the page composes them. An `<input type="reset">` reads its value, and one with no `value` reads `Reset`, as an `<input type="submit">` with none now reads `Submit`. Before, `getByRole('checkbox', { name })` resolved such a control while `toHaveAccessibleName('')` passed on the same locator and the agent saw an unnamed control; both now report the name Playwright's role selector matched.

- [#556](https://github.com/tester-army/e2e/pull/556) [`d87465b`](https://github.com/tester-army/e2e/commit/d87465b77fe1e04e981e9bddeaddd732c33c9861) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `web.route` or `web.onDialog` handler that failed after the test's last step no longer passes the test. The web engine kept such a failure for the next operation to throw, and a test that ended right after the request or the dialog had no next operation, so a failed `expect` inside the handler reported a pass; the same handler followed by a `web.url()` failed as expected. The runner now asks the engine to settle the attempt after the body and again after teardown, before the verdict: a handler still running gets the cleanup budget to finish, and the error it kept fails the attempt with its own code. A dialog handler's classified error (`ASSERTION_FAILED`, `POLICY_DENIED`) also keeps that code now instead of becoming an `ENGINE_FAILURE` infrastructure error, matching route handlers. Engines get an optional `settleAttempt` hook for this.

- [#546](https://github.com/tester-army/e2e/pull/546) [`d4ebb3a`](https://github.com/tester-army/e2e/commit/d4ebb3ad8f58fbabe4bbb0cc395c881ece524a60) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `expect(web).toHaveClass` waits for its node. Loaded from a project's config file, the engine and the runner's core are two copies of `e2e`, and the `LOCATOR_NOT_FOUND` a not-yet-rendered target raised was a `TestError` from the other copy: `instanceof` missed it, the read error escaped the poll, and the assertion failed within milliseconds while `toHaveAttribute('class', ...)` on the same locator waited and passed. The engine now recognizes a runner error by its name and code, so the matcher keeps polling until the deadline. An ambiguous target still fails at once with `LOCATOR_AMBIGUOUS`, and every other runner error crosses the engine boundary untouched whichever copy raised it.

- [#578](https://github.com/tester-army/e2e/pull/578) [`482ec57`](https://github.com/tester-army/e2e/commit/482ec573dc5a66e8c37a76c42b6ac3248768e534) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A locator read that lands on an element the app has just replaced re-resolves instead of reading the detached node. A field re-rendered as an identical clone on every animation frame reported `hidden` whenever a read caught the old element, so `toBeHidden()` could pass and `isHidden()` answer `true` while the field was on screen, by test id, label, or display value alike. The read now reports the match stale and the runner looks it up again within the same deadline; a field that is really removed still reads as hidden. Only a replaced element that could have been a match re-resolves, so a stable field found by exact label or display value resolves at once while unrelated fields re-render every frame.

- [#550](https://github.com/tester-army/e2e/pull/550) [`b1c36d9`](https://github.com/tester-army/e2e/commit/b1c36d94da162d578507f1516f7199a5e326e94b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A control's `disabled` state is the one the browser applies, not its own attribute alone. A button or field inside a `<fieldset disabled>` reads as disabled unless it sits in that fieldset's first `<legend>`, an `<option>` under a disabled `<optgroup>` too, and `aria-disabled="true"` on an ancestor disables the widgets below it, across a shadow root, until an `aria-disabled="false"` cuts the chain. Before, the engine read `el.disabled` and the element's own `aria-disabled` only, so a fenced button passed `toBeEnabled`, failed `toBeDisabled`, answered `false` to `isDisabled()`, and reached the agent's tree as enabled while Playwright reported it disabled. `toBeDisabled`, `toBeEnabled`, `isDisabled()`, `getByRole(..., { disabled })`, and the agent's observation now agree with Playwright's `toBeDisabled` on the same page.

- [#552](https://github.com/tester-army/e2e/pull/552) [`911d6ef`](https://github.com/tester-army/e2e/commit/911d6efb3f2a0b925f58099cfca80d486022fd64) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `contenteditable` editor's value keeps the whitespace it renders. The reader trimmed an editor's text before reporting it as the textbox value, so a `white-space: pre-wrap` editor holding `"  keep spaces  "` failed `toHaveValue('  keep spaces  ')` and passed `toHaveValue('keep spaces')`, while a native input with the same value did what the docs promise: `toHaveValue` compares a value as it is, spaces and newlines included. The value is now the rendered text as is, with two normalizations left: an editor whose document is only the `<p><br></p>` an empty editor renders, which the browser reads as a newline, still reads as `''`, and the zero-width no-break space Slate and Quill pad an empty line with is left out, so an empty Slate editor reads as `''` too. Code editors and rich text with leading or trailing whitespace assert on it correctly, and `inputValue()` returns the same text.

- [#549](https://github.com/tester-army/e2e/pull/549) [`ff148ce`](https://github.com/tester-army/e2e/commit/ff148cedd7a455c9beaf8eb310e3d1ba9167237e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An exact label query stays exact when it composes. `rows.filter({ has: screen.getByLabel('Name', { exact: true }) })` used to match a row whose input is labelled `Last Name` too, because the composed form went through Playwright's substring label match while the standalone query kept its own exact predicate; `.first().getByRole('button', { name: 'Remove' }).tap()` then removed the wrong row. The web engine now registers an `e2e-label` selector engine that runs the same reader in the page, so a `has` filter or a scope built on an exact label matches exactly what the standalone query matches, an aria-hidden required-field marker in the label included.

- [#551](https://github.com/tester-army/e2e/pull/551) [`9cd6b84`](https://github.com/tester-army/e2e/commit/9cd6b84650e5527f4cf6a97a3a25898e55093900) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A native checkbox, radio, or option reports the state the browser holds, not a stale `aria-checked` or `aria-selected` on the same element. Before, `<input type="checkbox" checked aria-checked="false">` read as unchecked, so `isChecked()` answered false, `toBeChecked` failed on a checked box, and the inverse markup made `toBeChecked` pass on an unchecked one; the agent's observation carried the same wrong state. The reader now does what Playwright's `toBeChecked` does: the control's own `checked` or `selected` wins, and ARIA fills in only for elements with no native state, such as a `div` with `role="checkbox"`.

- [#562](https://github.com/tester-army/e2e/pull/562) [`5051c34`](https://github.com/tester-army/e2e/commit/5051c34730db642b5d8fc42c4db1e280cbad2b2f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Reduce web observation overhead by transferring semantic metadata as JSON text through Playwright. Element handles, node references, and capture deadlines stay unchanged.

- [#554](https://github.com/tester-army/e2e/pull/554) [`8f31dba`](https://github.com/tester-army/e2e/commit/8f31dba68278dc5eb9f4b08aef81288ba4500f42) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web.waitForResponse` no longer reads a body the browser could not fetch as an empty string. A server that answers 200 and resets the connection before sending the declared `Content-Length` used to give `text()` an `''` and `json()` a parse error, so a test asserting an empty body passed and a test looking for the transport failure could not see one. The response still resolves with `url`, `status`, and `headers`; `text()` and `json()` now reject with `ACTION_FAILED` naming the cause, as they do for a request the page aborted and for a redirect, whose body the browser never keeps. A genuinely empty body still reads as `''`.

- [#591](https://github.com/tester-army/e2e/pull/591) [`eaac502`](https://github.com/tester-army/e2e/commit/eaac50292d4f71a0ca267263568be7152170c596) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The tree reads three controls the way Playwright's `getByRole` does: a `<select>` showing several rows (`size` above 1) is a `listbox`, an `<input>` whose `list` names a `<datalist>` is a `combobox`, and a `<td>` of a `role="grid"` or `role="treegrid"` table is a `gridcell`. A name read off the tree now finds the control with `getByRole`. A `listbox` counts as a control the agent can act on, as a `combobox` does.

- [#560](https://github.com/tester-army/e2e/pull/560) [`716d1db`](https://github.com/tester-army/e2e/commit/716d1dbbc4bfe2eedf56180a71e13583c07e03a5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `isVisible()`, `toBeVisible()`, and `toBeHidden()` on the web engine read visibility the way Playwright does. The reader used to count an element's client rects, so an SVG with `visibility: hidden`, a box with no width and no height, a button in the folded part of a closed `<details>`, and a `display: contents` element with nothing visible under it were all reported visible while Playwright called them hidden, and `toBeHidden()` failed on a page that showed nothing. Computed style is now read for any element, SVG included, a box is visible only with both a width and a height, closed `details` content outside its `summary` is hidden, and a `display: contents` element is visible when some child element or text is. The same state decides which nodes the agent's screen lists.
- Updated dependencies [[`89e2a19`](https://github.com/tester-army/e2e/commit/89e2a19a3932adf0bdbb3c2b2b8df7527f3a3750), [`f9f49f4`](https://github.com/tester-army/e2e/commit/f9f49f41ef521fd712db340ab291afa58e259ec6), [`676a015`](https://github.com/tester-army/e2e/commit/676a0153d88c9fb20d74e06c847e9303e18c4b59), [`8ff15d7`](https://github.com/tester-army/e2e/commit/8ff15d7cb2541490d29d0bb2dc64c2e9bcd1f126), [`786f65d`](https://github.com/tester-army/e2e/commit/786f65d8e4ede28c833717374cea6a23cd1b7164), [`c089fa6`](https://github.com/tester-army/e2e/commit/c089fa6cc21a3de7b925123b3e9fd8cf4165e29a), [`61603e6`](https://github.com/tester-army/e2e/commit/61603e6c2c103013eee2fe98c72066d59ac9363b), [`90356f1`](https://github.com/tester-army/e2e/commit/90356f17fcf515a0f05e4745235f645243acb51d), [`301e71d`](https://github.com/tester-army/e2e/commit/301e71d09be40c9f26c3bc4853d8f70d19b24d66), [`ac3eb57`](https://github.com/tester-army/e2e/commit/ac3eb57477137c5106d84d997745558f86be22ca), [`67c29fc`](https://github.com/tester-army/e2e/commit/67c29fc6b207822c9525360e6bf9c3130411a947), [`c1e9029`](https://github.com/tester-army/e2e/commit/c1e9029fed3ff5d58b147877228132e6a016ae86), [`dceae62`](https://github.com/tester-army/e2e/commit/dceae627300c2746b0a902cb90df75a0e1bb45a9), [`cf59269`](https://github.com/tester-army/e2e/commit/cf592694fea667dc25faaa514f3d65c7e13f63df), [`3e1a568`](https://github.com/tester-army/e2e/commit/3e1a5685b7336915da67ff4ef4cdfdf580f5e2d5), [`75e4145`](https://github.com/tester-army/e2e/commit/75e414536da73a23f37e213aab0a0880cd5869df), [`cb84c13`](https://github.com/tester-army/e2e/commit/cb84c13d8664c9637c19b9b9491cd727a0dfbb80), [`21b43b6`](https://github.com/tester-army/e2e/commit/21b43b6eb819b87d3c31fb5cdea36d10eac575ee), [`299c546`](https://github.com/tester-army/e2e/commit/299c546468a7e4cacc4084cfe0892c161530e333), [`2e96878`](https://github.com/tester-army/e2e/commit/2e968783bf6283d9fd507f06af1b559b323699db), [`a399bac`](https://github.com/tester-army/e2e/commit/a399bac83b927f8c5a58f4906bc25f1b992754ad), [`d0359eb`](https://github.com/tester-army/e2e/commit/d0359ebeef65835771667379c4fa51171fe670bb), [`d6947bc`](https://github.com/tester-army/e2e/commit/d6947bc66dca1d1d51dff20a67198f7929e1dfb5), [`11a286d`](https://github.com/tester-army/e2e/commit/11a286d54fc58ce1fc19d3317aa41122b271a1fd), [`bad98ea`](https://github.com/tester-army/e2e/commit/bad98ea2ebd4ab30fb7408b9b40467ea6a18caa9), [`93b45b7`](https://github.com/tester-army/e2e/commit/93b45b79c77ae78a9069e6442df51413771fc3bd), [`d87465b`](https://github.com/tester-army/e2e/commit/d87465b77fe1e04e981e9bddeaddd732c33c9861), [`eaac502`](https://github.com/tester-army/e2e/commit/eaac50292d4f71a0ca267263568be7152170c596), [`cef69d2`](https://github.com/tester-army/e2e/commit/cef69d26095a045d2282c9d43ad1f115e48b11dd)]:
  - e2e@0.15.0-canary-20260928184528

## 0.11.0-canary-20260925150007

### Minor Changes

- [#516](https://github.com/tester-army/e2e/pull/516) [`ec503c2`](https://github.com/tester-army/e2e/commit/ec503c2ea3e031c457509b93195f608cb8fd0a73) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An observed node carries `selection`, the text selected inside the focused field or editing host, and the screen the agent reads renders it as `selection="..."` beside the value. A `press` of `Shift+ArrowLeft` now shows what it selected, and `press` takes `times` (1 to 20, each press one recorded action, as a scroll repeat is), so the agent extends a selection to exactly one word in one more call, where before it pressed blind, one key per turn, and bolded the wrong span. A secure field reports no selection, as it reports no value. The web engine reads it from an input's or textarea's selection range and from the document selection inside a `contenteditable` host; a collapsed caret reports none.

### Patch Changes

- Updated dependencies [[`43d76ce`](https://github.com/tester-army/e2e/commit/43d76ce760b4d62148d4e129c77cbedd8a6aec7c), [`d6a1a30`](https://github.com/tester-army/e2e/commit/d6a1a30519951a3e588d7fe6d73d4ff0ef433b89), [`c1547c9`](https://github.com/tester-army/e2e/commit/c1547c9deb9619b6f90e4a98712ea080551e61cc), [`ec503c2`](https://github.com/tester-army/e2e/commit/ec503c2ea3e031c457509b93195f608cb8fd0a73), [`38e152a`](https://github.com/tester-army/e2e/commit/38e152a4aab06b4a1ce2ef46967b8f1931b3e35a)]:
  - e2e@0.15.0-canary-20260925150007

## 0.11.0-canary-20260924194828

### Patch Changes

- [#432](https://github.com/tester-army/e2e/pull/432) [`9614834`](https://github.com/tester-army/e2e/commit/9614834797dfac35ed89515bfa7b9cba82d5686a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The peer range on `e2e` is `>=0.15.0 <1` again instead of the exact version of one runner build, so updating `e2e` alone no longer leaves an unmet peer that npm refuses with ERESOLVE, and a runner release no longer republishes the engines and the reporter.

- [#433](https://github.com/tester-army/e2e/pull/433) [`a722039`](https://github.com/tester-army/e2e/commit/a7220398c9bf8c1bb0ba2aa7d5c334a9f455dc69) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `contenteditable` editing host, the root a TipTap, ProseMirror, Lexical, or Slate editor renders into, is a `textbox`: named by its `aria-label`, `aria-placeholder`, or the `data-placeholder` its editor paints, with its text as the value, so the agent types into it directly instead of falling back to the keyboard, a generic secret may fill it (a password still needs a password field), and `toHaveValue` reads it. The blocks inside it are content, not textboxes.
  
  Accessible names come from descendants the way Playwright's role selector computes them: `<button><img alt="Search"></button>` and an icon button whose only child is `<svg aria-label="Close">` are named, a descendant's own `aria-labelledby` and `title` count, `aria-labelledby` wins over `aria-label` as accname orders them, and a hidden element a control references still names it, so `toHaveAccessibleName` reads the name `getByRole` matched and the agent no longer sees anonymous icon buttons.

- [#424](https://github.com/tester-army/e2e/pull/424) [`c0f92d8`](https://github.com/tester-army/e2e/commit/c0f92d81102e39db4e3eabbce99770902008c432) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web.evaluate(fn)` runs a function that declares a named helper inside its body. The runner loads test files through tsx, whose esbuild `keepNames` output wraps `const pick = () => ...` in a module-scoped `__name` helper; the serialized source carried that call into the page, where it failed with `EVALUATE_FAILED: __name is not defined`. Only string sources and flat arrows worked. The page-side wrapper now declares the same helper beside the inlined source.

- [#478](https://github.com/tester-army/e2e/pull/478) [`d68762c`](https://github.com/tester-army/e2e/commit/d68762c16508beda13c051ceddc5c49f3740ad3c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getByRole`, `getByLabel`, `getByPlaceholder`, `getByText`, `getByDisplayValue`, and `getByTestId` resolve nodes inside closed shadow roots, the ones the observed tree already lists, so `fill`, `tap`, `press`, `toBeVisible`, `toHaveText`, `toHaveValue`, and `inputValue` work on a control a third-party widget renders that way. Playwright's own selectors stop at a closed root, so a failure used to print a node no query could reach. Every query part now searches its scope and each closed root the page attached under it, with Playwright's own role, name, text, label, and attribute rules and each node found once; strictness, `visible`, scopes, `filter({ has })`, and positions behave as before outside closed roots, and a position counts the matches outside a closed root first. Two compositions keep Playwright's reach and stop at a closed root: `web.locator(css)` and `filter({ hasText })`, whose text is read as Playwright reads it, so text inside a closed root does not count toward an element outside it. A page that attached no closed root pays nothing for the reach: the engine counts the closed roots a document attaches and skips the walk while there are none. A CDP context whose Playwright cannot register the selector engines fails the connection with a message naming what needs them: locators and secure-field masks.

- [#425](https://github.com/tester-army/e2e/pull/425) [`e119605`](https://github.com/tester-army/e2e/commit/e11960544e0dd0680dfffa56b4a2f22f50c79567) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A nested `frameLocator` chain resolves: `web.frameLocator('#outer').frameLocator('#inner').getByText('Saved')` looked the inner selector up in the page instead of the outer frame's document, reported `FRAME_NOT_FOUND` for `#inner` until the deadline, and the test failed `LOCATOR_NOT_FOUND` while Playwright's own `frameLocator` chain found the element. Each frame selector is now counted inside the frame before it, so a chain of any depth resolves, and a missing inner frame still fails `FRAME_NOT_FOUND` naming that selector even when the page happens to hold a matching element.

- [#478](https://github.com/tester-army/e2e/pull/478) [`d68762c`](https://github.com/tester-army/e2e/commit/d68762c16508beda13c051ceddc5c49f3740ad3c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getByLabel` finds a control that `aria-labelledby` names inside a shadow root, open or closed. The reader resolved the referenced id against the document, which never sees a shadow tree's ids, so the control had no label to match: `getByLabel('PIN', { exact: true })` failed `LOCATOR_NOT_FOUND` while `getByLabel('PIN')`, which Playwright matches on its own, resolved, and the observed tree listed the control unnamed. The id now resolves in the control's own tree, where the browser resolves it, so the exact query, `toHaveAccessibleName`, and the tree the agent sees name it alike. `toBeFocused` passes for a control inside a shadow root: `document.activeElement` is retargeted to the outermost host, so no node inside was ever reported focused; the reader now follows each root's `activeElement`, through open roots and the closed roots it records, to the element that holds focus.
- Updated dependencies [[`7d93c08`](https://github.com/tester-army/e2e/commit/7d93c085eb7d7c56c4007b870ff7f8b5c644d3d2), [`ed151e0`](https://github.com/tester-army/e2e/commit/ed151e042080371ab47dbbec49aa296011b34370), [`cc691d4`](https://github.com/tester-army/e2e/commit/cc691d472151d423637b3d22d477347644303068), [`66fb1e3`](https://github.com/tester-army/e2e/commit/66fb1e3d369cc5789fc768e4258f63e0b7120e2f), [`2ee94cc`](https://github.com/tester-army/e2e/commit/2ee94cc379779d62ab8e1b64a61852d25929bc93), [`3c52f93`](https://github.com/tester-army/e2e/commit/3c52f93272832892d6b36456df89d638b0bca084), [`8802b0f`](https://github.com/tester-army/e2e/commit/8802b0f0dc85fdd0bcdccc5b4ba6b351000d1769), [`edbb84f`](https://github.com/tester-army/e2e/commit/edbb84f6a1fcc57f6f8f5e7f88155691a96df369), [`ee4929d`](https://github.com/tester-army/e2e/commit/ee4929ddb6aa4de9004efd2e9107157103fd3c2f), [`91cacc9`](https://github.com/tester-army/e2e/commit/91cacc9e9ab6413308e3926885ec452d2e1a8371), [`4314f5f`](https://github.com/tester-army/e2e/commit/4314f5f8869b7d7369f1878b9ff23fd07790eb35), [`1de46ce`](https://github.com/tester-army/e2e/commit/1de46ce08c4943c17e4fdd16b0b18ee7a420307a), [`7ef3553`](https://github.com/tester-army/e2e/commit/7ef3553b67c90d18cafe63e9a496a16344603608), [`881afee`](https://github.com/tester-army/e2e/commit/881afee5c4973988b4811680b642e6ab6b1ec7bb), [`7aa0ffe`](https://github.com/tester-army/e2e/commit/7aa0ffe0b2425a5721bf5cf7a07335b03bd3c5b6), [`943de73`](https://github.com/tester-army/e2e/commit/943de73404259517ea8bdc7c36e6c830cb969142), [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02), [`e95135d`](https://github.com/tester-army/e2e/commit/e95135d5124c5008c79bc25b9f3cff8b89688d06), [`18cb9fc`](https://github.com/tester-army/e2e/commit/18cb9fcc3de47c4b49004f834a8d71fcc1f42f11), [`7753859`](https://github.com/tester-army/e2e/commit/77538594af6df0ca03aadd58b25cd090645f2a92), [`cdc4109`](https://github.com/tester-army/e2e/commit/cdc41098c7d3f5ba92705a87f758e470e859a559), [`e2b5570`](https://github.com/tester-army/e2e/commit/e2b557074ff4f18aa437fae351ac0ced6f02f53a), [`0dcf6a4`](https://github.com/tester-army/e2e/commit/0dcf6a492722b2e275c2f6b943ba728e5abd8dac), [`c975fb2`](https://github.com/tester-army/e2e/commit/c975fb26cc92bae4f42e4f26bc7f92d8a2df562e), [`1cb0c73`](https://github.com/tester-army/e2e/commit/1cb0c73c9ff846b5fef115a6bd3b805c0a540410), [`fa41517`](https://github.com/tester-army/e2e/commit/fa415178000d435fb97b6f07b9e1f0feb7743019), [`9c847ba`](https://github.com/tester-army/e2e/commit/9c847ba3e6f69ddbf84d39add17b7d993aadeb59), [`3bbcc96`](https://github.com/tester-army/e2e/commit/3bbcc968dddd1499db30b9a99ab949920cf98f74), [`6efc77d`](https://github.com/tester-army/e2e/commit/6efc77da5e4ca69468b5ce1b4eb6ac625d5c7c63), [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02), [`a0df697`](https://github.com/tester-army/e2e/commit/a0df69790679e02d7011dbaa3932028bac90b226), [`a9f8256`](https://github.com/tester-army/e2e/commit/a9f8256b800160eb88e6bb6efb69f767f9e2b000), [`cc23e51`](https://github.com/tester-army/e2e/commit/cc23e5142ec02dbecfbf555aa0d76e16c430c49a), [`5aaac75`](https://github.com/tester-army/e2e/commit/5aaac751f64141eb9fc80114ba945703ebc8709c), [`778fccc`](https://github.com/tester-army/e2e/commit/778fcccdfee595505b7905488aab9e3ff7067470), [`4305718`](https://github.com/tester-army/e2e/commit/4305718f1b43d362349698aaa28bac47d3e41271), [`33044a7`](https://github.com/tester-army/e2e/commit/33044a70e785ab94c77f01fff525648891a3e8b9)]:
  - e2e@0.15.0-canary-20260924194828

## 0.11.0-canary-20260922161512

### Patch Changes

- Updated dependencies [[`707c894`](https://github.com/tester-army/e2e/commit/707c8942fd13a9f67d0212c340c662ad152971d0), [`b71ecc0`](https://github.com/tester-army/e2e/commit/b71ecc0f09bd49801c2f4ff27a8822de846e7c3e)]:
  - e2e@0.15.0-canary-20260922161512

## 0.11.0-canary-20260922135036

### Minor Changes

- [#418](https://github.com/tester-army/e2e/pull/418) [`bda000c`](https://github.com/tester-army/e2e/commit/bda000cedf05b8ebdf3069763db943d0a26412e9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web({ browser })` accepts a `BrowserProvider`: an object that leases hosted browsers and hands back the CDP endpoint to attach to, released when their scope ends on every exit path. In `worker` scope (the default) the engine leases one browser per worker slot when the run starts and releases them all when it ends; a worker whose browser drops leases a replacement itself. In `attempt` scope it leases a fresh browser in every `startAttempt` and releases it in `endAttempt`, reattaching through the lease's `reconnectEndpoint` after a transport drop, with the same limits as `connect.reconnectEndpoint`. Slots lease in parallel; a slot that fails releases the others and ends the run before any test. A provider implies chromium and excludes `connect`, which stays as the low-level option. No vendor ships in the package; the browser guide shows an example provider against a generic session API. `BrowserProvider`, `BrowserProviderScope`, `BrowserRequest`, `BrowserLease`, and `BrowserReleaseContext` are exported.

### Patch Changes

- [#383](https://github.com/tester-army/e2e/pull/383) [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `Role` grows by the composite widgets and structure ported Playwright tests name: `tablist`, `tabpanel`, `menu`, `menubar`, `menuitemcheckbox`, `menuitemradio`, `progressbar`, `spinbutton`, `meter`, `toolbar`, `tooltip`, `group`, `separator`, `radiogroup`, `grid`, `gridcell`, `rowgroup`, `rowheader`, `tree`, `treeitem`, `article`, `figure`, and `form`. The list stays closed. `getByRole('img')` is accepted as an alias of `image` and builds the `image` query, so engines, the trace cache, and reports never see `img`.
  
  The web engine reads `role="img"` back as `image`, and its reader derives the new roles from HTML semantics (`<progress>`, `<meter>`, `<hr>`, `<fieldset>`, `<details>`, `<input type="number">`, `<thead>`/`<tbody>`, `<th scope="row">`, `<figure>`, `<article>`, a named `<form>` or `<section>`, `<header>`/`<footer>`/`<aside>` landmarks) instead of dropping them, and names a fieldset, figure, or table by its legend, figcaption, or caption.
  
  The mobile engine maps a tab bar, a segmented control, and a `TabLayout` to `tablist`, their items to `tab` (on iOS, the buttons inside a tab bar or segmented control), a progress indicator or `ProgressBar` to `progressbar` (an activity indicator stays `status`), a stepper or `NumberPicker` to `spinbutton`, and `Toolbar`, `Menu`, `MenuItem`, and `RadioGroup` to their roles on both platforms.
- Updated dependencies [[`eb739e9`](https://github.com/tester-army/e2e/commit/eb739e930d533db36206d622c960d18a1ba965e7), [`4c93414`](https://github.com/tester-army/e2e/commit/4c934142bc4ef4002811eff2be20d463343dd381), [`a577da3`](https://github.com/tester-army/e2e/commit/a577da3199c42402dfb9a04cd8452c5d89ab40dc), [`a583a88`](https://github.com/tester-army/e2e/commit/a583a88254cd80450f986174b022cf961442e7f0), [`0f864ad`](https://github.com/tester-army/e2e/commit/0f864ad3f3e7f5242ed957941e58e55e1a818aee), [`2b9361f`](https://github.com/tester-army/e2e/commit/2b9361ffea8e39d2c32a5b1e2a6a98c2da759380), [`2e4d40e`](https://github.com/tester-army/e2e/commit/2e4d40eb0754f2558e5e89fe80b4b4933183d023), [`0e525a0`](https://github.com/tester-army/e2e/commit/0e525a09dd2b8287280b1ede81a06d32dcb7f1d3), [`f01c01f`](https://github.com/tester-army/e2e/commit/f01c01fbe3a73f2e9380a7db2e62718517ab2e6b), [`d043035`](https://github.com/tester-army/e2e/commit/d04303523652b264b02af82d200f7cc726c044b3), [`dcfe53a`](https://github.com/tester-army/e2e/commit/dcfe53a4b0e4c70b5f9a01f980c6dffea021f8c9), [`ae930bb`](https://github.com/tester-army/e2e/commit/ae930bbf9a6d3793ad9f96e0efb2e8c36cb7665a), [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844)]:
  - e2e@0.15.0-canary-20260922135036

## 0.11.0-canary-20260921180210

### Minor Changes

- [#380](https://github.com/tester-army/e2e/pull/380) [`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine declares the `swipeTo` pointer action and performs it as a pointer drag from the point to `target`, which is what `screen.swipe({ from, to })` sends. Pointer actions at a point now land on the nearest whole CSS pixel: the browser truncates a fractional coordinate, so a tap composed from a fractional box used to land one pixel early.

- [#392](https://github.com/tester-army/e2e/pull/392) [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine packages are named after what they drive, not what they are built on. `@e2edev/playwright` is now `@e2edev/web` with a `web()` factory, and `@e2edev/agent-device` is now `@e2edev/mobile` with a `mobile()` factory; the engine names in reports and telemetry follow (`web`, `mobile`). Option types rename with them (`WebOptions`, `WebConnectOptions`, `WebBasicAuth`, `MobileOptions`, `MobilePlatform`), the agent tool pack is `mobileTools` from `@e2edev/mobile/tools`, and the `device` fixture keeps its name. `PlaywrightLiveSurface` keeps its name because it hands out Playwright objects. `e2e init` writes the new packages. Replace the dependency and the import in an existing project; the old packages are deprecated on npm and receive no further releases.

### Patch Changes

- [#365](https://github.com/tester-army/e2e/pull/365) [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Rebuilt against the engine contract with the optional `finish` hook and `EnginePrepareInfo.projectRoot`; the browser engine declares neither and behaves as before.

- [#380](https://github.com/tester-army/e2e/pull/380) [`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `screen.getByRole('image')` matches: the engine reads an `img` as the contract's `image` role but passed the query's spelling straight to the role selector, which only knows `img`, so an `image` query never found anything.
- Updated dependencies [[`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08), [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98), [`2e18196`](https://github.com/tester-army/e2e/commit/2e18196b79ac724c2a274a27562ea06d7a316d02), [`9f2b73f`](https://github.com/tester-army/e2e/commit/9f2b73f9293d4cdee449bb04e4f8272477d22402), [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8)]:
  - e2e@0.15.0-canary-20260921180210

## 0.11.0-canary-20260921154506

### Patch Changes

- [#373](https://github.com/tester-army/e2e/pull/373) [`ca5e619`](https://github.com/tester-army/e2e/commit/ca5e6196b620165dcabc383c1aaf35c44cf22690) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Relicense from MIT to Apache-2.0. The package ships the license text and a `NOTICE` file.
- Updated dependencies [[`45c08b1`](https://github.com/tester-army/e2e/commit/45c08b123e52369257433da2e133a84f2d6bdfa7), [`ca5e619`](https://github.com/tester-army/e2e/commit/ca5e6196b620165dcabc383c1aaf35c44cf22690), [`d438348`](https://github.com/tester-army/e2e/commit/d438348fda96a512cc03b51c41f1140353030003), [`b9abd60`](https://github.com/tester-army/e2e/commit/b9abd60c435935fc96816249f48315885d8ac85f), [`c1d23b2`](https://github.com/tester-army/e2e/commit/c1d23b230b8c8502f551e869710ed26f606a7469), [`ea27708`](https://github.com/tester-army/e2e/commit/ea2770804fe55857d105224355eef7b45453d665), [`195bd0d`](https://github.com/tester-army/e2e/commit/195bd0d14cc3f32440bfa140ed468dfa705d851d), [`da6b939`](https://github.com/tester-army/e2e/commit/da6b939e4c306b5dba64088599961a666f680c9a), [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83), [`f09b69e`](https://github.com/tester-army/e2e/commit/f09b69e90a8f76172ba5e5e006e7ec10dd99c172), [`f3d61e8`](https://github.com/tester-army/e2e/commit/f3d61e8ce7a8ab9a40090ecd72c9f43557a12492), [`d746ce4`](https://github.com/tester-army/e2e/commit/d746ce4b3f568c00ac736c116a561ef4e4dc67df), [`d7d843a`](https://github.com/tester-army/e2e/commit/d7d843af9d241246d225795b7d2439cb98a27a8a), [`bd2a9a6`](https://github.com/tester-army/e2e/commit/bd2a9a6db7c23193be6a914f961c3fb178074d59), [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83), [`e9c2914`](https://github.com/tester-army/e2e/commit/e9c2914c6d8f8d664d820b13a1fa454e9247e94b), [`91dcd30`](https://github.com/tester-army/e2e/commit/91dcd30b535331d89d197f6c5f3e8ae984e92960), [`ddf9747`](https://github.com/tester-army/e2e/commit/ddf97479d734b294f826b01b206e3b49cb7822bf), [`9fbba0b`](https://github.com/tester-army/e2e/commit/9fbba0b34c4f6a387d62914d35fc756b84ba7f8e)]:
  - e2e@0.15.0-canary-20260921154506

## 0.11.0-canary-20260917213813

### Patch Changes

- Updated dependencies [[`ba8d9ba`](https://github.com/tester-army/e2e/commit/ba8d9ba81de2879cbf216afaba0a0fe2a638cf11), [`15081f3`](https://github.com/tester-army/e2e/commit/15081f306837ebe1040fbcb2e63bd2efe283faaa), [`b558e78`](https://github.com/tester-army/e2e/commit/b558e78ba3b21cb86b20cc26bdd18aea08aa8a17), [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac), [`ed3999e`](https://github.com/tester-army/e2e/commit/ed3999e8931693f02a1a6e1737315fcea60f341b), [`95b3d7f`](https://github.com/tester-army/e2e/commit/95b3d7f41946bdf35d5865d9619e92f16e625866), [`99f9ea8`](https://github.com/tester-army/e2e/commit/99f9ea81cf3d40d4eb7966b9a98cdea9c2df1745)]:
  - e2e@0.15.0-canary-20260917213813

## 0.11.0-canary-20260917081546

### Minor Changes

- [#309](https://github.com/tester-army/e2e/pull/309) [`edaa1f2`](https://github.com/tester-army/e2e/commit/edaa1f2bf71a72fc63a59e3af1cb04ee9adfd849) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web.frameLocator` returns a `FrameScreen`: a `Screen` scoped to the frame
  that keeps the two web-only escape hatches. `locator(selector)` reaches a
  control inside the frame that has no accessible name, label, placeholder, or
  test id, and `frameLocator(selector)` steps into a frame nested in it. Both
  compile through the same frame chain as every query in that scope, so
  actionability, settle, and `expect` retries apply unchanged. An empty
  selector at any level throws `INVALID_LOCATOR`. The portable `Screen` is
  untouched; role and label queries remain the first choice wherever the
  control has a name.

- [#317](https://github.com/tester-army/e2e/pull/317) [`2e593df`](https://github.com/tester-army/e2e/commit/2e593dfb46dc71bc1785cb0ce80c35e34c0f1a90) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Recover semantic-capture timeouts with fresh, independently masked screenshots.
  The engine contract distinguishes unavailable semantics from a valid empty
  tree. Judgments obey their vision options, and every capture respects secret
  taint. The runner retires stale references and disables trace reuse for
  affected steps. Playwright supports
  the fallback; device captures still fail closed when accessibility data
  cannot establish screenshot masks.
  
  Playwright bounds the complete semantic capture and reserves node IDs before
  the reader starts. An abandoned capture cannot reuse IDs or publish late
  references. Pixel-only evidence resets the agent's semantic screen comparison
  and stops cache probes without discarding the recovered screenshot.
  
  Reports accept judgment steps that fail before a model call without inventing
  an observation revision or verdict explanation.

- [#306](https://github.com/tester-army/e2e/pull/306) [`17283c8`](https://github.com/tester-army/e2e/commit/17283c86dabad63631064d817196ae728c3a6136) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An unlabeled text control is now named by its placeholder, in the order
  HTML-AAM gives: `aria-label`, `aria-labelledby`, the associated label,
  `title`, then `placeholder` and `aria-placeholder`, for text-like inputs and
  textareas. A bare search box observes as `textbox "Search"` instead of an
  anonymous `textbox`, and `placeholder` joins the attributes an observation
  carries, so a cached action recorded against such a field relocates by its
  placeholder on replay. An observation that hit the node cap, or could not
  enter a child frame within it, now reports `truncated` on the snapshot instead
  of ending quietly.

- [#314](https://github.com/tester-army/e2e/pull/314) [`0b513d9`](https://github.com/tester-army/e2e/commit/0b513d989e7086bd3998fd0d105dbea0fdd5d004) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Declares the `keyboard` capability: `keyboard.type` types into whatever has focus through Playwright's keyboard, clearing first with select-all and delete when asked to replace, and refuses with `NOT_ACTIONABLE` when nothing that takes keystrokes has focus in any frame (the body, a button, a link, a select, a non-text input), so keystrokes never vanish into the page; a text field, a contenteditable host, a canvas, or any other element the app made focusable takes them. `keyboard.press` sends one key to the focused element.

- [#324](https://github.com/tester-army/e2e/pull/324) [`7fcb925`](https://github.com/tester-army/e2e/commit/7fcb925d76f41f1a8558abaa57a60de4ff365868) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Declares every pointer action at a bare point (`performAt` with the full `POINTER_ACTION_KINDS`): a click, double click, right click, held click, hover, drag between two points, and a wheel gesture from a point. `secondaryTap` on a node is a right click. Nodes report `pressed` from `aria-pressed` and `level` for headings (`aria-level`, else the `h1` through `h6` digit), and a role query passes `pressed` and `level` through to the browser.

- [#318](https://github.com/tester-army/e2e/pull/318) [`4bd7e64`](https://github.com/tester-army/e2e/commit/4bd7e644e0846d69d1525f4eebc3c100dce7138e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Add opt-in CDP transport recovery through `connect.reconnectEndpoint`. A dedicated persistent browser preserves the original page and context across disconnects, verifies their CDP identities, and invalidates stale references. Every attempt provisions a fresh browser, and dispatched operations are never repeated.
  
  Recovery and dispatch share one operation budget, with timeout exhaustion distinguished from caller cancellation. Reads from an earlier connection cannot publish stale observations, and each attempt owns its connection and recordings through cleanup.
  
  Observation-backed pointer and keyboard input requires fresh evidence after reconnect. Cancelled typing cannot continue its remaining keystrokes after a delayed focus read or key delivery.
  
  CDP attachment installs secure-field masks before exposing the context. Recovery refuses documents that lost closed shadow DOM tracking while disconnected, preventing unmasked pixels from those documents.

### Patch Changes

- Updated dependencies [[`0a4b7f4`](https://github.com/tester-army/e2e/commit/0a4b7f4fe9f3b316907ce896d21153a918f853e8), [`0b513d9`](https://github.com/tester-army/e2e/commit/0b513d989e7086bd3998fd0d105dbea0fdd5d004), [`1c9cc16`](https://github.com/tester-army/e2e/commit/1c9cc16697cb82c0a6db924f6c0f389886b2a468), [`9c835ba`](https://github.com/tester-army/e2e/commit/9c835ba64e866a8e87c1bcddc04376939edca74c), [`7fcb925`](https://github.com/tester-army/e2e/commit/7fcb925d76f41f1a8558abaa57a60de4ff365868), [`9249de2`](https://github.com/tester-army/e2e/commit/9249de20eea96fccc5b24e3747f36708eaf8edb8), [`2e593df`](https://github.com/tester-army/e2e/commit/2e593dfb46dc71bc1785cb0ce80c35e34c0f1a90), [`3524a59`](https://github.com/tester-army/e2e/commit/3524a59290da01a1adf28d83272eb5ecf0219c40), [`6016083`](https://github.com/tester-army/e2e/commit/60160830154972d31e81b10ddc90f6c63776a470), [`4c76360`](https://github.com/tester-army/e2e/commit/4c76360cb65b20c5193240b0e5a0489bd7e0c558), [`17283c8`](https://github.com/tester-army/e2e/commit/17283c86dabad63631064d817196ae728c3a6136), [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac)]:
  - e2e@0.15.0-canary-20260917081546

## 0.11.0-canary-20260914134810

### Patch Changes

- Updated dependencies [[`5908a10`](https://github.com/tester-army/e2e/commit/5908a107f97d6f3845ed75c5676cc514b6f03dcd)]:
  - e2e@0.15.0-canary-20260914134810

## 0.11.0-canary-20260914095510

### Patch Changes

- Updated dependencies [[`f2f2e6f`](https://github.com/tester-army/e2e/commit/f2f2e6fb1024ffb4cd481f7ea571c2d29be6d6d8), [`ec3b6a1`](https://github.com/tester-army/e2e/commit/ec3b6a145a9e1a58bc70227ba4e868d7c9e3c3e5)]:
  - e2e@0.15.0-canary-20260914095510

## 0.11.0-canary-20260914081513

### Minor Changes

- [#290](https://github.com/tester-army/e2e/pull/290) [`799b29f`](https://github.com/tester-army/e2e/commit/799b29fbfa0444589b66bc0e59ab0b83ededf50c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Origin allowlists are gone, everywhere. `web({ allowedOrigins })` gated typed navigation only; a click, a redirect, or a popup reached any origin regardless, so the list guarded nothing and had to be spelled out for every subdomain a sign-in flow touched. `allowedOrigins` on a credential or a secret gated where a password could be typed; a secret is only ever typed into a field the step was handed, a password only into a password field, so that gate guarded against a model mistake at the cost of configuring every flow that leaves the app's domain, a third-party sign-in included. `app.open()`, the agent's `navigate`, and `web.goto` open any http(s) URL, `file:`, `data:`, and `javascript:` stay `POLICY_DENIED`, and a secret fills wherever the test or the step directs it. `credentials` entries are `{ username, password }`; `secrets` entries are a string or a provider, the `{ value }` object form is gone. `type_secret` now works on a device target too. What still keys on the site of `url` (its registrable domain) is invisible to config: the browser engine's `headers` reach the site and no other host, and child frames off the site stay out of observations. `basicAuth` answers a challenge from any origin, as Playwright's own `httpCredentials` does. Engine contract: `EngineAppInfo.allowedOrigins` became `site?: string`, `EngineAppDeclaration` lost `allowedOrigins`, and `sameSite`/`siteOf` are exported from `e2e/engine`. `web({ allowedOrigins })` fails at config load. If a threat model ever calls for an allowlist again, it comes back as an opt-in.

- [#291](https://github.com/tester-army/e2e/pull/291) [`abf1958`](https://github.com/tester-army/e2e/commit/abf19588677070fb86234f735614c40b7677e755) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: follows the reshaped engine contract. `web({ testIdAttribute })` names the attribute `getByTestId` and observed `testId` values read (default `data-testid`); the root config key `screen.testIdAttribute` no longer exists. `app.restart()` and `app.clearState()` land on a blank page and the runner reopens the app. Observations carry one `root` node (the document, id `root`) and `location` (the page URL).
  
  Fixed: `screen.getByTestId` now honors the configured attribute; it used Playwright's process-wide default before.

- [#294](https://github.com/tester-army/e2e/pull/294) [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The runner is published as `e2e`. `@e2edev/e2e` is retired and deprecated on npm; every import, config, and peer range now names `e2e` (`e2e`, `e2e/agent`, `e2e/engine`). The engines and the GitHub reporter declare their peer dependency on `e2e`, so a project on `@e2edev/e2e` must switch the runner to `e2e` when it takes these versions. The CLI keeps its `e2e` bin name.

### Patch Changes

- Updated dependencies [[`abf1958`](https://github.com/tester-army/e2e/commit/abf19588677070fb86234f735614c40b7677e755), [`aa3b05b`](https://github.com/tester-army/e2e/commit/aa3b05bbbdd4534ef111e51b950002513998076f), [`e301105`](https://github.com/tester-army/e2e/commit/e3011054080237f6141419f738a680574308765b), [`d486e40`](https://github.com/tester-army/e2e/commit/d486e40e73bfe23ac70a99f7938f05db0ba4e30c), [`799b29f`](https://github.com/tester-army/e2e/commit/799b29fbfa0444589b66bc0e59ab0b83ededf50c), [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59)]:
  - e2e@0.15.0-canary-20260914081513

## 0.10.0

### Minor Changes

- [#272](https://github.com/tester-army/e2e/pull/272) [`dfc4feb`](https://github.com/tester-army/e2e/commit/dfc4febe46da37420643b51bb969f423800d22fe) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `playwright` is no longer installed by this package. It is a peer dependency, `>=1.63.0 <2`, replacing the pinned `playwright` dependency the engine carried. Add it to your project:
  
  ```bash
  npm install --save-dev playwright
  ```
  
  An app that already depends on Playwright for its own product keeps its version, one copy in `node_modules`, and one browser cache; before, the engine pulled in a second copy pinned to another revision, and `playwright install` provisioned two browser sets. A version outside the range may be rejected by the package manager as an unmet peer (npm's `ERESOLVE`), so upgrade `playwright` within `>=1.63.0 <2`. The floor is 1.63 because `basicAuth` maps to the per-origin `httpCredentials` list that release added. Projects scaffolded with `e2e init` need no change: init now adds `playwright` alongside the engine.

- [#258](https://github.com/tester-army/e2e/pull/258) [`c553b61`](https://github.com/tester-army/e2e/commit/c553b614def4da798be5bfa3f7f04591dc253b69) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine declares `tapAt`: a click at one viewport point in CSS pixels with no
  element resolved behind it, which the agent's `tap_at` uses when the point the
  model named in a screenshot lands on nothing the tree lists. Nodes inside same-origin
  iframes now carry boxes in the top-level viewport's coordinates rather than
  their own document's, so a hit test over the screenshot resolves them.

## 0.9.0

### Minor Changes

- [#260](https://github.com/tester-army/e2e/pull/260) [`da6323e`](https://github.com/tester-army/e2e/commit/da6323e555292c921ffc9771960cb164119f6f7e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Observations now reach two kinds of content a person sees and the tree did not.
  
  Closed shadow roots: a context init script wraps `Element.prototype.attachShadow`
  before any page script runs and records each closed root by its host; the
  in-page reader walks those roots exactly like open ones. Third-party storefront
  widgets (returns, upsell, consent) render checkout buttons and links this way,
  and until now every model scrolled for a control that could not appear until
  the step budget ran out. Node ids and refs work inside these roots as
  everywhere else, so `tap`, `fill`, and the other actions reach them. Playwright
  locators (`screen.getByRole`) still cannot, as before. Screenshot masking
  follows: a registered selector engine, `e2e-closed=<css>`, matches inside the
  recorded roots, so a password field there is covered in observation pixels and
  artifact screenshots like any other. Declarative `<template shadowrootmode="closed">` roots are
  not attached by script and stay out of reach.
  
  `display: contents` elements: such an element generates no box, so its empty
  client rect list read as hidden and its whole subtree was dropped. Shopify's
  one-page checkout form is styled this way, which left every Shopify checkout
  without a single field in the tree. The element itself stays out of the tree
  unless it carries semantics; its children now decide their own visibility.

## 0.8.0

### Minor Changes

- [#247](https://github.com/tester-army/e2e/pull/247) [`f11f881`](https://github.com/tester-army/e2e/commit/f11f8813e5cb6c77eaab339f2ac2074e8491478a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web()` takes `headers` and `basicAuth`, so an app behind a gate - a
  Vercel preview under deployment protection, an ngrok tunnel with its
  interstitial, a staging host behind HTTP basic authentication - is reachable
  on every path onto the page, `agent.act` included, where before
  only a `web.route` handler in a deterministic test could add a header.
  `headers` ride every request bound for an allowed origin and no other, so a
  bypass secret never leaves the app it unlocks; `basicAuth` answers a `401`
  challenge from an allowed origin only. Both are validated at config load.

### Patch Changes

- [#245](https://github.com/tester-army/e2e/pull/245) [`38d4424`](https://github.com/tester-army/e2e/commit/38d4424eb1fd2e16ab5fd2fb1fc6b64862ced3a7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `stopTrace` returns every trace archive the attempt wrote, in order, when a restart or a state reset cut the trace (`trace/trace-part<n>.zip` before `trace/trace.zip`), so the runner registers and redacts each segment instead of only the final one.

## 0.7.1

### Patch Changes

- [#239](https://github.com/tester-army/e2e/pull/239) [`5b6f594`](https://github.com/tester-army/e2e/commit/5b6f5947a5e64a1cbb3575d3a9424afdcbb0b2e2) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A node an exact label query or a display-value query found is pinned to its
  element. Such a match is one candidate among many (every labelable control,
  every input with a value), and its ref used to re-resolve by position when the
  action ran, so a page that inserted or removed an element in between made the
  action land on a neighbor: a `fill` on a "Project Name" field hit a button
  and failed as "not an input". The handles are taken first and the semantics
  are read from those very handles, so what was read and what is acted on are
  one set of elements. Handles that did not match are released at once, and a
  located element ref is released when the registry prunes or clears it, so a
  long attempt no longer accumulates browser objects.

## 0.7.0

### Minor Changes

- [#226](https://github.com/tester-army/e2e/pull/226) [`adbc92c`](https://github.com/tester-army/e2e/commit/adbc92c928c6d1d28e65773ccbe58876f4de14a4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Both engines declare their platform on the handle: `web` for playwright, the
  `platform` option for agent-device. A target that names them no longer has to
  repeat it. Both engines now require `@e2edev/e2e` 0.8 or newer (peer range
  `>=0.8.0 <1`): an older runner rejects `platform` as an unknown engine key,
  and could still send `states.hidden` in a role query, which these engines no
  longer read.

- [#233](https://github.com/tester-army/e2e/pull/233) [`a659f5f`](https://github.com/tester-army/e2e/commit/a659f5f5fcfc0fa97b5b460fa595d8bbf558cd0a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Video recording. With `artifacts: ['video']` or `--video`, the engine screencasts the attempt's page to `video/video.webm` at the attempt's viewport size, one segment per page: a restart or a state reset opens a new page and continues in `video/video-part<n>.webm`.

- [#225](https://github.com/tester-army/e2e/pull/225) [`47be7f8`](https://github.com/tester-army/e2e/commit/47be7f867da427cfa05f999c9af32ed5fd6eb6ba) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `SelectOption` on the engine contract gains a `{ value }` variant. Playwright
  selects by the option's `value` attribute; the device engine's `selectOption`
  stays `UNSUPPORTED_CAPABILITY` for every variant.

### Patch Changes

- [#234](https://github.com/tester-army/e2e/pull/234) [`7d4ca98`](https://github.com/tester-army/e2e/commit/7d4ca981917114ad5f5955805fea7b235d6e932b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A control's name and its labels no longer include text marked `aria-hidden`.
  A required field whose label ends in a hidden asterisk was named
  `"Display name*"`, so `getByLabel('Display name')` and `getByRole('textbox',
{ name: 'Display name' })` found nothing while every screen reader said
  "Display name". Names follow the accessible name computation: aria-hidden
  subtrees are dropped, CSS-hidden ones stay out as before, and hidden text
  between visible fragments is skipped too. Screen text is untouched:
  `getByText('Display name*')` still finds the label, and a node's `text` still
  reads as a person sees it. An exact label query is now decided by the engine
  over every labelable element in scope (button, input, meter, output, progress,
  select, textarea, and anything with `aria-label` or `aria-labelledby`),
  matching any of the element's labels (an `aria-label`, an `aria-labelledby`
  target, or an associated `<label>`) the way Playwright's `getByLabel` does; as
  a scope or `has` filter it composes through Playwright's substring label match.

- [#223](https://github.com/tester-army/e2e/pull/223) [`68620ef`](https://github.com/tester-army/e2e/commit/68620ef7459739f89f7846decd54af1c8e5105e9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Role queries no longer read a `hidden` state from the query: the engine
  contract dropped it. Playwright's role locator keeps its default of matching
  only nodes exposed to assistive technology; the device engine skips hidden
  nodes in role queries as it did by default.

## 0.6.1

### Patch Changes

- [#194](https://github.com/tester-army/e2e/pull/194) [`d9ecd33`](https://github.com/tester-army/e2e/commit/d9ecd338d8f7c34f79395c874c2f975fe55094eb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Both engines now require `@e2edev/e2e` 0.5.0 or newer. They import
  `@e2edev/e2e/engine`, which 0.5.0 introduced (0.4.x shipped `/backend`), so
  the old `>=0.4.0` range allowed an install whose every import failed.

- [#205](https://github.com/tester-army/e2e/pull/205) [`76aaeb1`](https://github.com/tester-army/e2e/commit/76aaeb16b642c12d8a6f4dfb3d899a579b814e44) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Release observation metadata after each capture so repeated agent observations do not retain earlier node arrays in the browser.

## 0.6.0

### Minor Changes

- [#175](https://github.com/tester-army/e2e/pull/175) [`766cf52`](https://github.com/tester-army/e2e/commit/766cf52c0db44be69d05079fa4f97726c3e5fa15) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Node.js 22.12 is the floor. Node 20 reached end of life in April 2026; the
  `engines` field, the CLI's startup check, and the docs now all say 22.12.

- [#167](https://github.com/tester-army/e2e/pull/167) [`bbe8420`](https://github.com/tester-army/e2e/commit/bbe842042737f5df92766628429e5eb1cf67239f) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Add `toBeFocused` and `toHaveAttribute` locator matchers, and make `getAttribute` read any attribute present on the element.
  Add `expect(web).toHaveClass(target, expected)` to the web fixture.

### Patch Changes

- [#161](https://github.com/tester-army/e2e/pull/161) [`41612dc`](https://github.com/tester-army/e2e/commit/41612dcf44e6e395d578a23c09cf1dd451231095) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Package and CLI descriptions no longer call e2e a "standard".

- [#168](https://github.com/tester-army/e2e/pull/168) [`1ef5b00`](https://github.com/tester-army/e2e/commit/1ef5b003b62a588f554ad567f9d1f4540ffd8b35) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - READMEs and CLI help use the scoped package names (`@e2edev/e2e`,
  `@e2edev/web`, `@e2edev/mobile`) on every install line, point at
  the Fern docs instead of e2e.dev, and describe e2e as an open framework for
  agentic end-to-end testing.

## 0.5.0

### Minor Changes

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The app under test is declared by the engine that drives it, not by the
  config. The top-level `app` key (`url`, `command`, `readyUrl`, `services`,
  `allowedOrigins`, `environment`, `identity`) is gone, and so is the runner's
  `APP_URL` fallback: the browser engine takes the same fields as options,
  `web({ url, command, services, ... })`, and the device engine derives
  the identity from the app it pins (`mobile({ platform, app })`, or an
  explicit `identity`). Two web targets on one app each name it; services and
  commands declared identically by several targets start once.

  For engine authors, the `app` manifest of `defineEngine` carries the
  declaration (`EngineAppDeclaration`) beside its hooks, and the runner
  resolves it per target: navigation policy, cache and session identity, the
  report's target record (`baseOrigin` is now absent for a surface without a
  URL), and the app process all read from there. A device target can finally
  declare a stable identity without inventing a URL. `@e2edev/e2e/engine` also
  exports `obj`, the one-call replacement for the conditional-spread
  idiom when a declaration is built from optional inputs.

  Migrate by moving the `app` block into the engine factory:

  ```ts
  // before
  app: { url: 'http://localhost:3000' },
  targets: [{ name: 'web', platform: 'web', engine: web() }],
  // after
  targets: [{ name: 'web', platform: 'web', engine: web({ url: 'http://localhost:3000' }) }],
  ```

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Rename the "backend" concept to "engine" everywhere. The authoring import is now `@e2edev/e2e/engine` (`defineEngine`, `EngineHandle`, `EngineError`, `EngineFixtureContext`, ...), a target names its engine as `engine: web()` in `e2e.config.ts`, the error code `BACKEND_FAILURE` is now `ENGINE_FAILURE`, and the `backend` provenance field in the report and session schemas is now `engine`. `@e2edev/e2e/backend`, `defineBackend`, `backend:` and `BACKEND_FAILURE` are gone; update the import path, the config key, and any code matching on the error code or reading provenance.

### Patch Changes

- [#145](https://github.com/tester-army/e2e/pull/145) [`24a5763`](https://github.com/tester-army/e2e/commit/24a5763e8bf234d481778d19f420f83335cc6e48) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getByDisplayValue(...)` now supports `first()`, `last()`, `nth()`, and `filter({ hasText, has })` in the playwright engine, so a display-value locator can be narrowed, acted on, and asserted like every other query. Positions apply to the value-filtered matches, not to every form control on the page. Previously any refinement failed with `UNSUPPORTED_CAPABILITY: displayValue queries cannot be used as scopes or filters in this engine`. The two compositions Playwright's locator chain cannot express remain unsupported and now say so precisely: a display-value query as the scope of a child query, and as a `has` filter.

- [#149](https://github.com/tester-army/e2e/pull/149) [`f810e23`](https://github.com/tester-army/e2e/commit/f810e2324b02b189cbbb6242a55da5d587285932) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Every `screen` query accepts `visible: true`, which drops nodes the platform reports as hidden before the exactly-one rule runs: `getByText('No memories yet', { visible: true })` resolves the copy a person sees even while a framework keeps a `display:none` twin in the document after a reload. Omitted or `false` keeps every match, so existing `LOCATOR_AMBIGUOUS` failures still fire. The predicate is the node's own `hidden` state, the one `toBeVisible()` reads, and it composes with scopes, `filter`, `first`, `last`, and `nth`. `getByTestId` gains the same optional `{ visible }` argument.

  The engine contract's `SemanticQuery` carries the flag as `visible`; the Playwright and agent-device engines evaluate it from the hidden state they already report, and the harness holds a top-level query to the same predicate as a backstop.

## 0.4.0

### Minor Changes

- [#133](https://github.com/tester-army/e2e/pull/133) [`d14a79c`](https://github.com/tester-army/e2e/commit/d14a79c0420e25a2db9244bff4e107af42395a04) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `surfaceOf(handle)` exposes the live `Page` and `BrowserContext` behind a
  `web()` handle to agent-side code, the way `@e2edev/mobile`
  exposes its device surface. A step executor that replaces the toolset
  wholesale can now drive the page e2e itself opened, instead of attaching a
  second browser it cannot reach. Both accessors read the current attempt and
  throw `INVALID_STATE` before it exists; the harness remains the notary for
  what it witnesses, and a caller here acts out of band.

### Patch Changes

- [#131](https://github.com/tester-army/e2e/pull/131) [`04f4a43`](https://github.com/tester-army/e2e/commit/04f4a43574c65dbb6b1cdb406da569727f56368c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An exception thrown by the page inside `web.evaluate` is now a test failure,
  `EVALUATE_FAILED`, carrying the page's own message, as the spec's evaluation
  rules describe. It was reported as infrastructure (`BACKEND_FAILURE`, exit
  code 3) with Playwright's call prefix in front of the message, so a script
  that failed a check read like a broken browser. A page-side result envelope
  distinguishes these exceptions from transport failures. Timeouts, page and
  browser closure, crashes, protocol failures, and a document lost to navigation
  keep their infrastructure classification.

- [#129](https://github.com/tester-army/e2e/pull/129) [`c4b74ee`](https://github.com/tester-army/e2e/commit/c4b74ee4fdbbd00bc919a4b287250c5f0e2234f3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Replace the keyed browser pool with a single shared connection per worker, preserving reconnect and in-flight launch cleanup.

- [#132](https://github.com/tester-army/e2e/pull/132) [`bc87f15`](https://github.com/tester-army/e2e/commit/bc87f15b3b62258f8e9c059873e1f89a67ba27de) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Keep secret redaction and pixel taint with the live session across serial members. Route device model screenshots through guarded observations and reserve project-tool action budgets before dispatch, serializing mutations with grammar actions.

  Add explicit fixture operation declarations, preserve legacy factories, mark contributed assertions as verification steps, and isolate asynchronous step attribution. Share cancellation helpers; deprecate optional tool annotations whose replay and secret semantics are not implemented.

  Preserve fixture object identity and mutable state when recording declared operations, and retain artifacts and viewport metadata attached before a legacy synchronous failure.

  Bound device located references and reuse snapshot location metadata. Both reference backends require e2e >=0.4.0 for the new fixture and lifecycle helpers.

## 0.3.0

### Minor Changes

- [#115](https://github.com/tester-army/e2e/pull/115) [`b08a668`](https://github.com/tester-army/e2e/commit/b08a668eed39e3d68b5f5d15335eef9895bdb15f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Backends get a `prepare` hook: once per run and target, in the runner process,
  before any worker starts and outside every launch budget. The Playwright
  backend installs a missing browser there instead of inside `init`, so a
  first-run download is no longer charged against `launchTimeout`, no longer runs
  once per worker, and its progress streams as new `notice` run events. The list
  reporter prints those above its live status block, where before the block's
  repaint erased the download output written to a worker's stderr and a first run
  looked hung on a spinner.

- [#113](https://github.com/tester-army/e2e/pull/113) [`6a2918c`](https://github.com/tester-army/e2e/commit/6a2918cf98117d5c06a815422498923ee2c1c043) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Observation node ids are stable per element: the reader stamps an id on each
  element the first time it is observed and reads it back afterwards, so an
  element keeps its id across observations for as long as it lives in the
  document, and an executor can diff two observations instead of re-reading
  the screen. Closed `<select>` controls list their options (up to 60) as child
  nodes. Table rows and cells are observed as `row`, `cell`, and
  `columnheader` nodes instead of being flattened into their text and buttons,
  so a control inside a row can be told apart from the same control in the
  next row.

## 0.2.0

### Minor Changes

- [#114](https://github.com/tester-army/e2e/pull/114) [`e19b826`](https://github.com/tester-army/e2e/commit/e19b826a7f2a944122099851803f6961f107cf86) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Publish under the `@e2edev` npm scope as restricted (private) packages: the core package `e2e` is now `@e2edev/e2e`, beside `@e2edev/web` and `@e2edev/mobile`. Entry points move with the name (`@e2edev/e2e/agent`, `@e2edev/e2e/backend`, `@e2edev/e2e/run`); the `e2e` CLI binary keeps its name. Provenance is off while the packages are private, since npm only attests public packages.

- [#101](https://github.com/tester-army/e2e/pull/101) [`8c97039`](https://github.com/tester-army/e2e/commit/8c9703906c476af6dea063c44ddc179399b102e5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - **Breaking.** Playwright is a backend, and core knows no platform (RFC0002
  step 2'). The bumps stay `minor` under the 0.x policy, but the shapes below
  are removed or changed and a project upgrading must migrate its config and any
  backend it wrote.

  Removed:

  - `@e2edev/e2e/driver`, `defineDriver`, and every driver-SPI type; the `driver:` and
    `browser:` target keys; the top-level `browser` config key; the implicit
    zero-config web target. `targets` is required and a target is
    `{ name, platform, backend? }`.
  - The `actions` verb object on a backend (`actions: { tap, type, press,
select, scroll, navigate, back }`). Every node action is now
    `perform(ref, action, context)` taking one `LocatorAction`; viewport scroll
    is `swipe(direction, momentum, context)`; `navigate` and `back` live under
    `app: { navigate?, back?, restart?, clearState? }`. The `actions` capability
    means `perform` is declared, and the agent offers the model only the verbs
    the backend declares.
  - `artifacts: ['video']` is no longer accepted in config, and `video` is gone
    from the report's `artifactCapabilities` (a fixture may still attach a
    `video` artifact).
  - `DRIVER_FAILURE` is now `BACKEND_FAILURE`.

  Changed:

  - `Backend.version` is required (a non-empty string): it is provenance and
    keys the trace cache.
  - `endAttempt(context)` and `dispose(context)` receive a
    `BackendCleanupContext` (`{ signal, timeoutMs }`) whose `signal` aborts when
    the cleanup budget is spent. `dispose` runs whether or not `init` ran, and
    `init` may run again after `dispose` on the same handle.
  - `defineBackend` validates the nested `state`, `artifacts`, and `app`
    manifests (closed keys, function members), binds every method so a class
    instance is a valid body, and rejects unknown nested keys with
    `INVALID_CONFIG`.
  - `BackendInitInfo.app.baseUrl` and `BackendFixtureContext.app.baseUrl` are
    optional; absent when no app URL is configured.
  - `Web`, `WebRoute`, `WebResponse`, `RouteFulfillResponse`, `Cookie`,
    `Dialog`, and `WebExpectation` moved out of `e2e` into `@e2edev/web`.
    `expect(fixture)` routes to whatever expectation surface a backend attaches
    through `BackendFixtureContext.expectable`. Every `web` method call,
    including `url()`, `title()`, and `cookies()`, is now a recorded step.
  - Reports and session envelopes record `backend: { name, version, spiVersion }`
    instead of `driver`, drop `browser`/`browserVersion`/`viewport` from target
    provenance, and step events use kind `backend` (spec `suiteVersion` 0.6.0).

  Added:

  - `@e2edev/web` exports `web(options)`: a `defineBackend` handle
    with observation, actions, location, state, artifacts, and the contributed
    `web` fixture. `browser` and `viewport` are its options. It also exports
    `test` typed with `web`; `expect` and `credentials` still come from `e2e`.
  - `@e2edev/e2e/backend` exports `BACKEND_ERROR_CODES` and
    `RETRYABLE_BACKEND_ERROR_CODES` (`NODE_STALE`, `FRAME_NOT_FOUND`).
  - `@e2edev/e2e/backend` exports the semantics the spec requires every backend to
    reproduce exactly: `TestError`, `ConfigurationError`, `InfrastructureError`,
    `matchesText`, `toTextPattern`, `describePattern`, `urlMatches`,
    `pollCondition`, `Deadline`, and `validateJsonValue`. The `@e2edev/e2e/internal`
    subpath is removed; a backend package depends on `@e2edev/e2e/backend` only.
  - `defineTool` accepts `platforms` to scope a tool pack to targets by
    platform, and `StepExecutorContext.target` names the target a step runs on.

  Migration:

  ```ts
  // before
  export default defineConfig({
    browser: "chromium",
    targets: [{ name: "web", platform: "web", driver: "playwright" }],
  });

  // after
  import { web } from "@e2edev/web";

  export default defineConfig({
    targets: [
      {
        name: "web",
        platform: "web",
        backend: web({ browser: "chromium" }),
      },
    ],
  });
  ```

  A backend written against the earlier `@e2edev/e2e/backend` draft moves its `actions`
  verbs onto `perform` (switch on `action.kind`), its viewport `scroll` onto
  `swipe`, its `navigate`/`back` under `app`, declares `version`, and accepts
  the cleanup context on `endAttempt`/`dispose`.

- [#105](https://github.com/tester-army/e2e/pull/105) [`f64b191`](https://github.com/tester-army/e2e/commit/f64b1917d3f87b84e83e7475ec9368068fc7b3ec) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web({ connect })` attaches to a remote browser over the Chrome DevTools
  Protocol instead of launching a local one. `connect.cdpEndpoint` is an async
  resolver called at worker init, and again on any reconnect, so a hosted browser
  whose endpoint is provisioned per run — a cloud session URL not known at config
  load — resolves each time the pool needs it. CDP attach is chromium-only (the
  factory rejects another engine as `INVALID_CONFIG`), a local launch skips the
  browser-install step it no longer needs, and disposing the backend detaches the
  CDP session without killing the remote process the host owns.

- [#20](https://github.com/tester-army/e2e/pull/20) [`1e21658`](https://github.com/tester-army/e2e/commit/1e21658c949900be0191221a468647e43b6ddf2a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move the Playwright driver into its own `@e2edev/web` package.

  `e2e` no longer depends on `playwright`, so installs that drive another backend
  no longer download a browser. `driver: 'playwright'` still works and is still
  the default for web targets; the runner now loads the driver from
  `@e2edev/web`, which it declares as an optional peer dependency.

  **Upgrading:** install the driver alongside the runner.

  ```bash
  npm install --save-dev @e2edev/e2e @e2edev/web
  ```

  A target that names the driver without the package installed now fails config
  resolution with `DRIVER_NOT_INSTALLED` and exit code 2, naming the package to
  install.

  Also in this release:

  - Drivers can implement an optional `prepare` hook, run once before any session
    launches, for slow one-time provisioning. Browser downloads now happen there,
    so they are never charged against a launch timeout for any driver, not just
    the built-in one. A failing `prepare` aborts the run as an infrastructure
    error instead of a test failure.
  - The list reporter now prints run-level errors. Previously a run that failed
    during config, collection, or provisioning exited non-zero with the reason
    only in `report.json`.
  - The `e2e/playwright` subpath export is removed; import from
    `@e2edev/web` instead.

- [#78](https://github.com/tester-army/e2e/pull/78) [`61b31dd`](https://github.com/tester-army/e2e/commit/61b31dd95e431804e5bdb17a37da325d4dca10ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Locate nodes that no query can name, and observe shadow roots and `data:` frames.

  An agent step whose target has no accessible name, test id, placeholder, or text
  used to fail with `LOCATOR_NOT_FOUND` before it looked at the page. The model had
  already selected the right node; the runner discarded it because no portable
  query could be derived from it — so the agent tier failed hardest on exactly the
  controls that have no deterministic address either, such as an input whose label
  is the table cell beside it.

  The locate sweep now falls through to the two paths that need no query:

  - the node's **observed reference**, which the driver backs with the element
    itself, and
  - the driver's **platform selector** for the node when it has an anchored one, in
    which case the located node carries a real locator instead of a reference and
    so survives into the cache and into `dragTo`. Recorded as the
    `locate.selector` policy decision.

  Both paths re-read the live node and require its recorded identity before acting,
  exactly as replay does, so a stale selection is still a miss rather than a blind
  dispatch. `poll: false` callers keep their early exit for escalation.

  One observation gap closes alongside it in `@e2edev/web`: **open shadow
  roots are walked**, so a control that exists only in a shadow tree is now
  selectable. Slotted content is not double-counted — slotted elements are
  light-DOM children, and the shadow tree holds `<slot>` placeholders rather than
  copies. A closed root stays invisible, as it is to a person reading the page.

  Empty painted rectangles are observed, and a drag can end on one.

  A drop zone, a colour swatch, a chart placeholder: an element defined by being
  empty carries no role, name, text, or test id, so the observation walk skipped it
  and no instruction could name it. An empty element that paints something — a
  border, an outline, a background of its own — and is at least 12 CSS pixels on
  each side is now reported with the role `box`. Nothing else changes: an unpainted
  spacer of the same size is still omitted, because a person cannot see it either.

  `dragTo` also no longer requires a locator on both sides. `Locator.dragTo` takes
  two locators, so a destination the agent reached through its observed reference
  made the whole verb unavailable — exactly for the elements that have no locator.
  When either endpoint is reference-backed the driver drives the pointer instead,
  which is also what makes HTML5 drag-and-drop commit, since it needs a real
  `dragover`. A drag whose _source_ is reference-only still fails: `dragTo` locates
  twice and every observation disposes the generation before it, so the source
  handle does not survive to the dispatch. That is an observation lifecycle
  question, not a drag one.

### Patch Changes

- [#86](https://github.com/tester-army/e2e/pull/86) [`347aa7d`](https://github.com/tester-army/e2e/commit/347aa7ded66fd774ffe859399a3c030cd405df3b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agent.act()` ships on a harness-owned step-executor socket (RFC0001 v0).

  The harness owns each planned step — observation redaction, the action
  grammar (`tap`, `type`, `typeSecret`, `press`, `select`, `scroll`,
  `navigate`), budgets, deadlines, origin policy, and recording — and delegates
  only the thinking to a pluggable `StepExecutor`, configured as the `agent`
  value itself: `agent: createAgent({...})` or any hand-rolled executor (there
  is no `executor` key). The `@e2edev/e2e/agent` entrypoint exports `createAgent` (the
  built-in AI SDK tool-loop executor), `createToolLoopExecutor` (the chassis:
  verdict tool, hard stops, loop guards, wind-down, `--debug` transcripts), and
  `defineTool` for annotated project tools. Verdicts are ternary: `blocked` is first-class
  in the report (step and run status) with a closed category taxonomy
  (credentials, environment, seed_data, test_setup, automation). `Secret`
  values flow into `act` params as placeholders and fill only through the
  authorized `typeSecret` action. With a custom executor, `agent.assert` also
  dispatches through the socket.

  Breaking changes:

  - The AI SDK (`ai`) is now an optional peer dependency (`^7.0.0`) instead of
    a hard dependency. Model-backed calls require it installed; deterministic
    suites and custom executors run without it.
  - `reporters` accepts only `'list' | 'json'` (the unimplemented `'html'`
    value is removed) and defaults to `['list']`.
  - The `limits` block accepts only enforced keys; the ten
    validated-but-unenforced keys (`maxDiscoveredResults`, `maxArtifactBytes`,
    `maxArtifactTotalBytes`, `maxDownloadBytes`, `maxDownloads`,
    `maxReportBytes`, `maxTerminalFieldBytes`, `maxModelCallsPerStep`,
    `maxActionStepsPerStep`, `maxEstimatedCostUsd`) are rejected.
  - `report-1` documents changed (limits/usage blocks, `blocked` statuses, new
    error codes); the conformance `suiteVersion` is now 0.2.0.
  - `verifyDriver` and its conformance types are removed from `@e2edev/e2e/driver`
    until the harness can actually run vectors.

- [#107](https://github.com/tester-army/e2e/pull/107) [`e0ac8af`](https://github.com/tester-army/e2e/commit/e0ac8af5ca2247eef0962945b7500efede1bbb8d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Observation and lifecycle hardening in the browser backend:

  - One deadline bounds a whole observation: settling, the main document, every
    same-origin iframe, and the pixels each spend from what remains, so nested
    frames can no longer stretch one `observe` past the operation budget.
  - An observation cancelled by the harness no longer publishes its handle
    generation over the one the caller still holds refs into.
  - `locate` no longer derives a CSS selector for every matched element on every
    assertion poll; nothing consumed it. The tree walk memoizes role, name, and
    direct text per element and reuses the computed style it already holds, and
    each document is read with one fewer protocol round trip.
  - A function dialog handler that returns without calling `accept` or `dismiss`
    now has the dialog dismissed and fails the next step with `INVALID_STATE`
    instead of leaving the page blocked behind it.
  - A first-run browser download and the browser launch honour the init signal.
  - A trace segment that cannot be written during `clearState` or session
    restore is best-effort and can no longer leave the surface on the old context.

- [#79](https://github.com/tester-army/e2e/pull/79) [`bc0f377`](https://github.com/tester-army/e2e/commit/bc0f377a0a2b5c9e9cea5cfffbcf94a1e8dcd7ae) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Harden the boundary between the runner and an out-of-tree driver.

  A driver's `DriverError` is now recognized structurally rather than with
  `instanceof`. A driver imported by a config file resolves through a different
  module registry than the runner, so the two hold different copies of the class
  and `instanceof` misses. Every typed driver failure then lost its taxonomy: a
  retryable `NODE_STALE` stopped being retried and surfaced as a generic failure
  instead of a recoverable race. This affects any driver package, including
  `@e2edev/web` whenever a project ends up with more than one copy of
  `e2e` resolved.

  Builds now clear `dist` before compiling. `tsc` only writes files, so output
  whose source has since moved or been deleted survived every later build and was
  published: after the Playwright driver moved out of `e2e`, the `e2e` tarball
  still carried a full copy of the old `dist/playwright` tree.

- [#107](https://github.com/tester-army/e2e/pull/107) [`e0ac8af`](https://github.com/tester-army/e2e/commit/e0ac8af5ca2247eef0962945b7500efede1bbb8d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Correctness and speed fixes across the runner's support layers:

  - `agent.act` params and `web.evaluate` values that reach the same object by
    two paths are no longer rejected as cycles.
  - A setup test filtered out by its own `platforms` list can no longer be
    promoted to run on a target it excluded; a consumer that needs it is a
    collection error, as for a missing capability.
  - Trace start and end paths pass the secret redactor before they are written;
    a redacted path marks the trace non-replayable. The start-path precondition
    now compares by pathname like the end postcondition, so a differing query
    string no longer cold-misses the cache.
  - Negated assertions with a budget shorter than the one-second grace window
    can pass again; `toHaveCount` polls within its assertion deadline.
  - Replay relocation projects each observed node once per observation instead
    of once per recorded action per tier; wire regexps are compiled once; text
    sanitizing and UTF-8 truncation are single-pass; value matchers format
    failure messages only on failure; test discovery skips dot-directories.
  - Dead code removed: the unused `internal/backend-text` module, the unused
    `selectorExpression`, and several exports that had no consumer.

- [#74](https://github.com/tester-army/e2e/pull/74) [`9334e8f`](https://github.com/tester-army/e2e/commit/9334e8f35cbaacbe61b10b3489ea87a920aeb99a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Ship package metadata for the registry: repository, homepage, bug tracker,
  keywords, and the MIT `LICENSE` file. Releases publish under the `beta`
  dist-tag while the surface stabilizes, so `latest` is not moved.

- [#107](https://github.com/tester-army/e2e/pull/107) [`e0ac8af`](https://github.com/tester-army/e2e/commit/e0ac8af5ca2247eef0962945b7500efede1bbb8d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `web.route` registers on the browser context, not the current page: a route
  now applies before the first page opens, to popups, and across `app.restart()`,
  `app.clearState()`, and session restore, as the attempt-scoped contract in the
  spec requires. Previously a stub silently stopped firing after any of those.
