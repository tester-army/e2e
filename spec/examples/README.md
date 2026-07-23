# Examples

A realistic suite for **Orbit** — a fictional project-management SaaS with a
web app and a React Native mobile app. These files are spec artifacts: they
must read well and typecheck against [`api.d.ts`](../api.d.ts); they are the
acid test that the API works for real use cases, not just the README pitch.

## What each example demonstrates

| File | Demonstrates |
|---|---|
| [`e2e.config.ts`](./e2e.config.ts) | targets (web/ios/android), credentials, agent config |
| [`e2e.cloud.config.ts`](./e2e.cloud.config.ts) | cloud overlay — only the deltas |
| [`tests/auth.setup.e2e.ts`](./tests/auth.setup.e2e.ts) | setup tests producing sessions |
| [`tests/signup.e2e.ts`](./tests/signup.e2e.ts) | the happy path: agent + email inbox + OTP |
| [`tests/onboarding.e2e.ts`](./tests/onboarding.e2e.ts) | serial group, cross-step data via `extract` |
| [`tests/tasks/task-crud.e2e.ts`](./tests/tasks/task-crud.e2e.ts) | deterministic-heavy `screen` tests, chaining/filtering, sessions |
| [`tests/tasks/attachments.e2e.ts`](./tests/tasks/attachments.e2e.ts) | `files` resource + agent uploads |
| [`tests/billing/checkout.e2e.ts`](./tests/billing/checkout.e2e.ts) | all three tiers in one test, `step()`, tags |
| [`tests/billing/plans.e2e.ts`](./tests/billing/plans.e2e.ts) | `test.each` parameterization, typed `act` schema |
| [`tests/notifications.e2e.ts`](./tests/notifications.e2e.ts) | cross-platform branching, mobile-only `device`, `platforms` |
| [`tests/flags.web.e2e.ts`](./tests/flags.web.e2e.ts) | `web`-only powers: `route()` stubbing, dialogs, `waitForURL` |
| [`tests/integrations/webhooks.e2e.ts`](./tests/integrations/webhooks.e2e.ts) | `webhook.capture()` + resource matchers |

## Organizing a large suite

What this structure looks like at ~300 tests:

```
tests/
  auth.setup.e2e.ts          # sessions: 'member', 'admin', 'owner'
  smoke/                     # tag: smoke — the PR gate, < 5 min
  tasks/                     # feature areas own their folders
  billing/
  integrations/
  mobile/                    # platforms: ['ios','android'] flows
fixtures/                    # files used by tests (resume.pdf, avatar.png)
e2e.config.ts
e2e.cloud.config.ts
```

Conventions that keep it manageable:

- **Sessions over logins.** One setup test per role; hundreds of tests start
  authenticated (`session: 'member'`). Login flows themselves are tested
  once, in `auth.setup` + dedicated auth tests.
- **Tags are the execution axis, folders the ownership axis.**
  `tags: ['smoke']` for the PR gate, `['billing']` for team filters:
  `npx e2e run --tag smoke`.
- **Independent by default.** `{ serial: true }` only for genuinely
  sequential flows (wizards). Everything else parallelizes freely —
  `--shard 1/4` in CI needs no cooperation from test authors.
- **Tier discipline.** Stable, hot paths drift toward `screen`
  (deterministic, free); flows where the UI churns stay agentic — the
  locate cache converges them anyway. `agentContext` per group captures app
  quirks once.

CI (GitHub Actions):

```yaml
jobs:
  e2e:
    strategy:
      matrix: { shard: [1/4, 2/4, 3/4, 4/4] }
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx e2e run --shard ${{ matrix.shard }}
        env:
          APP_URL: ${{ steps.preview.outputs.url }}
```
