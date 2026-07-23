# e2e — API Specification

This directory is the source of truth for the public API of `e2e`, the
open-source, cross-platform, agentic testing framework.

**Status: draft. Spec only — no implementation exists yet.**

## Why

There is no cross-platform testing framework built on agentic testing.
`e2e` is one cross-platform API — deterministic parity with Playwright and
Maestro for migrators (12-migration.md), agentic testing as the reason to
switch:

> The last testing framework you will ever need.

## Documents

| Doc | Contents |
|---|---|
| [01-principles.md](./01-principles.md) | Why, design principles, non-goals |
| [02-test-api.md](./02-test-api.md) | `test()`, fixtures, `agent` (planning + instant actions) |
| [03-assertions.md](./03-assertions.md) | `expect()` (locator/web/value matchers), `agent.assert()` |
| [04-resources.md](./04-resources.md) | `credentials`; the resource model (email/webhook/files/phone are extensions, roadmap) |
| [05-config.md](./05-config.md) | `defineConfig()` and `e2e.config.ts` |
| [06-cli.md](./06-cli.md) | `npx e2e …` command surface |
| [07-cloud.md](./07-cloud.md) | TesterArmy Cloud boundary: what is OSS vs Cloud |
| [08-platforms.md](./08-platforms.md) | Cross-platform targets, `screen` queries, `web`, `app`, `device` |
| [09-drivers.md](./09-drivers.md) | Drivers as packages: community backends, public SPI (`e2e/driver`) |
| [10-determinism.md](./10-determinism.md) | The control gradient, execution model, caching, error codes |
| [11-lifecycle.md](./11-lifecycle.md) | Setup tests + sessions, hooks, groups, serial mode |
| [12-migration.md](./12-migration.md) | Playwright & Maestro parity tables — the migration contract |
| [examples/](./examples/README.md) | A realistic example suite (Orbit) exercising the full surface |
| [roadmap/](./roadmap/README.md) | Deferred designs: PR testing, service emulation |

## Package

- npm package: `e2e`
- Subpath exports: `e2e`, `e2e/cloud`, `e2e/driver` (SPI for backend packages)
- Official drivers: `e2e/playwright`, `e2e/agent-device`, … (subpath exports, optional peer deps); community: `e2e-driver-*` packages
- Test files: `*.e2e.ts` (default glob: `tests/**/*.e2e.ts`)
- Config file: `e2e.config.ts`

## The 10-second pitch

```ts
import { test } from 'e2e';

export default test('user can sign up', async ({ app, agent }) => {
  await app.open();

  await agent.act('sign up as a new user');

  await agent.assert('the dashboard is visible');
});
```

```bash
pnpm add e2e
npx e2e run
```

## Normativity

These documents are the spec; the TypeScript blocks inside them are the
normative surface. Every symbol the package exports must appear here first.
[examples/](./examples/README.md) must stay consistent with the docs — it is
the acid test that the API works for real suites; once the package exists,
the examples compile against it in CI.
