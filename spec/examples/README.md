# Examples

A realistic suite for **Orbit** — a fictional project-management SaaS with a
web app and a React Native mobile app. These files are spec artifacts: they
must read well and stay true to the [spec docs](../README.md); they are the
acid test that the API works for real use cases, not just the README pitch.
Once the package exists, they compile against it in CI.

## What each example demonstrates

| File | Demonstrates |
|---|---|
| [`e2e.config.ts`](./e2e.config.ts) | targets (web/ios/android), credentials, agent config |
| [`tests/auth.setup.e2e.ts`](./tests/auth.setup.e2e.ts) | setup tests producing sessions |
| [`tests/signup.e2e.ts`](./tests/signup.e2e.ts) | the happy path: pure agentic flow + a deterministic check |
| [`tests/onboarding.e2e.ts`](./tests/onboarding.e2e.ts) | serial group, cross-step data via `extract` + typed schema |
| [`tests/tasks/task-crud.e2e.ts`](./tests/tasks/task-crud.e2e.ts) | deterministic-heavy `screen` tests, chaining/filtering, sessions |
| [`tests/billing/checkout.e2e.ts`](./tests/billing/checkout.e2e.ts) | all three tiers in one test, tags |
| [`tests/notifications.e2e.ts`](./tests/notifications.e2e.ts) | cross-platform branching, mobile-only `device`, `platforms` |
| [`tests/flags.web.e2e.ts`](./tests/flags.web.e2e.ts) | `web`-only powers: `route()` stubbing, dialogs, `waitForURL` |

## Organizing a large suite

What this structure looks like at ~300 tests:

```
tests/
  auth.setup.e2e.ts          # sessions: 'member', 'admin', 'owner'
  smoke/                     # tag: smoke — the PR gate, < 5 min
  tasks/                     # feature areas own their folders
  billing/
  mobile/                    # platforms: ['ios','android'] flows
e2e.config.ts
```

Conventions that keep it manageable:

- **Sessions over logins.** One setup test per role; hundreds of tests start
  authenticated (`session: 'member'`). Login flows themselves are tested
  once, in `auth.setup` + dedicated auth tests.
- **Tags are the execution axis, folders the ownership axis.**
  `tags: ['smoke']` for the PR gate, `['billing']` for team filters:
  `npx e2e run --tag smoke`.
- **Independent by default.** `{ serial: true }` only for genuinely
  sequential flows (wizards). Everything else parallelizes freely across
  workers with no cooperation from test authors.
- **Tier discipline.** Stable, hot paths drift toward `screen`
  (deterministic, free); flows where the UI churns stay agentic — the
  locate cache converges them anyway. `agentContext` per group captures app
  quirks once.

CI (GitHub Actions):

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx e2e run
        env:
          APP_URL: ${{ steps.preview.outputs.url }}
```
