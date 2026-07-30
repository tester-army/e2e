# @e2edev/testbed

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
- `e2e.agent.config.ts` + `tests-agent/` — opt-in agentic suite against the same
  playground: located actions, assisted polling, judgments, schema-validated
  extraction with zod, host-side secret fills, and mixed agentic/deterministic
  flows in a serial group.

## Commands

```bash
pnpm --filter e2e build            # the testbed runs the built runner
pnpm --filter @e2edev/testbed test    # typecheck + local suite (starts the app itself)
pnpm --filter @e2edev/testbed test:headed
pnpm --filter @e2edev/testbed test:public   # real websites, not in CI
E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent   # real model calls, not in CI
pnpm --filter @e2edev/testbed app     # run the playground manually
```

The local suite runs in CI on every push. Reports land in `.e2e/report.json`;
artifacts under `.e2e/artifacts/`.

## Agentic suite

`test:agent` spends real model calls, so it is opt-in and never runs in CI. It
pins `google/gemini-3-flash` and honours `E2E_MODEL` so the same suite can be
replayed across providers:

```bash
E2E_MODEL_API_KEY=...  pnpm --filter @e2edev/testbed test:agent
E2E_MODEL=openai/gpt-5.4-mini E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent
```

Agentic assertions are structurally comparable across models, not textually
identical, so these tests assert on meaning (`toContain`) and pair every
agentic step with a deterministic locator check.
