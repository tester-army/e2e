# Playwright parity

Playwright's own page tests, rewritten against the e2e public API, so
`web()` is held to Playwright's behavior. Adapted from microsoft/playwright
`tests/page` (and `tests/library/download.spec.ts`) at `v1.64.1`, the version
`playwright-core` is pinned to. Copyright Microsoft Corporation, Apache
License 2.0: see `LICENSE` and `NOTICE`.

- `../tests-parity/*.e2e.ts`: one file per Playwright spec. Each keeps the
  original test's title, inputs, and assertions; `page.click(selector)` becomes
  a locator tap, `page.setContent(html)` a page the server serves
  (`content()`). A test whose API e2e does not expose is left out; the file
  header lists them.
- `../tests-parity/expected-gaps.txt`: the tests e2e fails on purpose or by a
  known gap, per browser, each with its reason.
- `assets/`: Playwright's `tests/assets` files the tests load, unchanged.
- `server.mjs`: serves `assets/`, plus the routes Playwright's test server sets
  per test as fixed paths. `127.0.0.1` and `localhost` on port 4311 are the
  two origins of the cross-origin cases.

`../e2e.parity.config.ts` runs every file on a `chromium` and a `firefox`
target against one server. The path of each target's app URL names the
browser, which the tests read as the `browserName` fixture.

```sh
pnpm build
pnpm --filter @e2e-dev/testbed test:parity
pnpm --filter @e2e-dev/testbed test:parity tests-parity/page-route.e2e.ts
```

`test:parity` fails on a failure `expected-gaps.txt` does not list, on a
listed test that passes (the gap closed: delete its line), and on a listed
test that skipped or is gone. After a fix or a new port,
`E2E_PARITY_UPDATE=1 pnpm --filter @e2e-dev/testbed test:parity` rewrites the
list from the run, keeping existing reasons and marking new lines `TODO`,
which fails until the reason is written.
