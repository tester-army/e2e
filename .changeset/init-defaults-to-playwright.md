---
"@e2edev/e2e": minor
---

`e2e init` defaults to the Playwright engine, both as the first wizard choice
and under `--yes`, with AI enabled; `None` and `agent-device` stay selectable.
The generated config reads `APP_URL` (default `http://localhost:3000`) and
shows the `command` option and `createAgent({ model })` in comments. The
example test opens `/` and asserts `web.locator('body')` is visible, so it
passes against any page with no model key. `package.json` gains a
`test:e2e` script when missing, engine dependencies use `0.x` instead of the
`beta` tag, `init` suggests a `tsconfig.json` when none exists, and the
closing line prints `APP_URL=http://localhost:3000 npx --no-install e2e run`.
