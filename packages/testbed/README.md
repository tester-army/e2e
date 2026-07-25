# @e2e/testbed

Dogfood workspace for the [`e2e`](../e2e) runner: a real project consuming the
`e2e` package exactly like a user would, with a growing suite of deterministic
tests.

## Layout

- `app/server.mjs` — dependency-free playground app (todos, login/session,
  forms, wizard, network, dialogs, iframes, downloads). The runner starts and
  stops it via `app.command`.
- `e2e.config.ts` — local config used by `pnpm test`.
- `tests/` — the local suite: queries, actions, polling assertions, sessions
  (`test.setup` + `session:`), serial groups, routes, dialogs, frames,
  downloads, keyboard input, credentials/secrets.
- `e2e.public.config.ts` + `tests-public/` — opt-in suite against real public
  websites (example.com, iana.org, playwright.dev), dogfooding the production
  opt-in and multi-origin policy.

## Commands

```bash
pnpm --filter e2e build            # the testbed runs the built runner
pnpm --filter @e2e/testbed test    # typecheck + local suite (starts the app itself)
pnpm --filter @e2e/testbed test:headed
pnpm --filter @e2e/testbed test:public   # real websites, not in CI
pnpm --filter @e2e/testbed app     # run the playground manually
```

The local suite runs in CI on every push. Reports land in `.e2e/report.json`;
artifacts under `.e2e/artifacts/`.
