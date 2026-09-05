# Examples

This is the canonical source suite for Orbit, a fictional project-management
app. Examples are informative but MUST type-check against `sdk-0.1` and remain
consistent with normative behavior.

The config runs one web target because v0 is web-only. Portable test source can
be used by future mobile profiles; `notifications.e2e.ts` includes one reserved
mobile example that is filtered out of the v0 target matrix.

## Coverage

To start a new project, run `npx @e2edev/e2e@beta init` and pick Playwright
for a browser example or agent-device for a mobile one (Settings on iOS when
run on macOS, Android elsewhere). `--yes` skips the prompts and writes an HTTP
example with no backend.

| File | Demonstrates |
|---|---|
| `e2e.config.ts` | web target, structured app process, credentials, model config |
| `auth.setup.e2e.ts` | static setup outputs and per-target sessions |
| `signup.e2e.ts` | planning plus deterministic assertion |
| `onboarding.e2e.ts` | whole-group serial state, typed extraction, code data flow |
| `tasks/task-crud.e2e.ts` | independent deterministic tests and locator refinement |
| `billing/checkout.e2e.ts` | both control tiers in one test |
| `notifications.e2e.ts` | platform branch and reserved mobile capability |
| `flags.web.e2e.ts` | explicit web capability, routes, dialogs, URL waits |

## Isolation conventions

The runner isolates backend/client attempts, not Orbit's database. The task
examples use separately seeded boards so parallel tests do not mutate the same
records. Real suites should use per-test tenants, unique entities, isolated
fixtures, or serial groups for shared backend workflows.

Sessions remove repeated UI login but do not isolate accounts or server data.
Setup state is captured fresh for every runner invocation.

## Suite organization

Tags are the execution axis and folders are the ownership axis. Serial groups
are limited to workflows whose members intentionally share state. Stable hot
paths use `screen`; dynamic flows use the narrowest agent method that fits.

## CI

CI installs from a frozen lockfile and runs the local binary. Agent tests need
an explicit model and provider credential. The workflow below is for a trusted
branch or internal PR only. It MUST NOT run fork code with these secrets.
Untrusted fork execution requires an external ephemeral sandbox with no secrets,
write token, production access, or shared state; privileged reporting belongs
in a separate trusted job as required by 14-security.md.

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - run: pnpm install --frozen-lockfile
  - run: pnpm e2e run
    env:
      APP_URL: ${{ steps.preview.outputs.url }}
      APP_ENVIRONMENT: staging
      E2E_MODEL: ${{ vars.E2E_MODEL }}
      E2E_MODEL_API_KEY: ${{ secrets.E2E_MODEL_API_KEY }}
      MEMBER_PASSWORD: ${{ secrets.MEMBER_PASSWORD }}
      ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
```
