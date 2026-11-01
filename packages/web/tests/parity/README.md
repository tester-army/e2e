# Behavior parity

Playwright's own page tests, rewritten against the e2e public API, so
`web()` is held to Playwright's behavior. Adapted from microsoft/playwright
`tests/page` (and `tests/library/download.spec.ts`) at `v1.64.1`, the version
`playwright-core` is pinned to. Copyright Microsoft Corporation, Apache
License 2.0: see `LICENSE` and `NOTICE`.

- `tests/*.e2e.ts`: one file per Playwright spec. Each keeps the original
  test's title, inputs, and assertions; `page.click(selector)` becomes a
  locator tap, `page.setContent(html)` a page the server serves (`content()`).
  A test whose API e2e does not expose is left out; the file header lists them.
- `assets/`: Playwright's `tests/assets` files the tests load, unchanged.
- `server.mjs`: serves `assets/`, plus the routes Playwright's test server sets
  per test as fixed paths. `127.0.0.1` and `localhost` on its port are the two
  origins of the cross-origin cases.

A test that hits a place where e2e differs from Playwright on purpose or
by a known gap is skipped with `e2eGap(reason)`.

```sh
pnpm build
cd packages/web/tests/parity
BROWSER=chromium node ../../node_modules/e2e/dist/cli/bin.js run
BROWSER=firefox node ../../node_modules/e2e/dist/cli/bin.js run
```

`PARITY_PORT` (default 4311) moves the server. Parallel runs each need their
own `PARITY_PORT` and `--output .e2e-<name>`, and must not share a browser:
`page-screenshot` writes its goldens into the shared `tests/` snapshot folder.
