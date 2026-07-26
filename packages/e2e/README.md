# e2e (reference implementation)

Reference runner for the [e2e specification](../../spec). This package
implements the deterministic subset of specification 0.1:

- **sdk-0.1** — `test` registration (`describe`, hooks, `test.setup`, serial
  groups), `expect` (locator, web, and value matchers), `credentials`,
  `defineConfig`, and the frozen public types.
- **runner-0.1 (deterministic)** — config discovery/validation, collection with
  stable test IDs, selection (tags, `.only`, platforms, capabilities, session
  producers, serial closure), clean attempts, retries, timeouts, per-run
  encrypted sessions, exit-code precedence, the list reporter, and
  schema-valid `report-1` documents.
- **driver-1** — the `e2e/driver` SPI with `defineDriver` and `DriverError`.
- **web-0.1 (deterministic)** — runner-owned query polling/strictness, locator
  actions and reads, `app` lifecycle, `web` navigation/routes/cookies/dialogs/
  downloads/evaluation, and screenshot/trace artifacts through the
  `e2e/playwright` reference driver.

Not implemented yet: agentic execution (`agent.*` rejects with
`MODEL_UNAVAILABLE`), locate/path caches, the HTML reporter, video artifacts,
and mobile targets (rejected per the v0 boundary). `--no-agent-cache` is
accepted per spec 06-cli.md but no agent cache exists yet.

## Parallel execution

`workers`/`--workers` schedules file-target units across worker processes
(spec 11-lifecycle.md). Each worker re-loads the config module, owns one
driver instance (one browser), and executes one unit at a time; per-target
setup tests complete before ordinary units dispatch, serial groups stay
atomic on one worker, and a worker is discarded after any failing unit or
infrastructure fault. Results stream back over IPC and the report orders them
independently of completion time. In-memory configs (the programmatic
`rawConfig` option) cannot cross process boundaries and fall back to
sequential in-process execution.

## Usage

```bash
e2e init
APP_URL=http://localhost:3000 e2e run
```

Missing Playwright browsers are downloaded automatically on first run. To
provision them ahead of time (for example in a CI image), run
`npx playwright install chromium`.

```ts
import { test, expect } from 'e2e';

test('user signs in', async ({ app, screen, web }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await screen.getByRole('button', { name: 'Sign in' }).tap();
  await expect(web).toHaveURL('/dashboard');
});
```

## Development

```bash
pnpm build      # tsc -> dist
pnpm typecheck
pnpm test       # builds, then runs unit + integration suites
```

Integration tests run fixture projects through the built runner against a
local fixture app and validate every generated report against
`spec/schema/report-v1.schema.json`.
