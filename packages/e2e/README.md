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
- **agent-protocol-1 (located actions and judgments)** — atomic semantic
  observations, the closed `agent-locate-1`/`agent-judgment-1` grammars,
  runner-owned budgets, ledger, policy, and error classification behind
  `agent.tap`, `click`, `type`, `longPress`, `scroll`, `scrollTo`, `waitFor`,
  `extract`, and `assert`.

Not implemented yet: the planning tier (`agent.act` and `agent.login` reject
with `UNSUPPORTED_CAPABILITY`), locate/path caches (`cache-1`; every agent step
reports `cache: bypassed`), the HTML reporter, video artifacts, step source
locations, and mobile targets (rejected per the v0 boundary).

## Parallel execution

`workers`/`--workers` schedules file-target units across workers (spec
11-lifecycle.md). One scheduler drives every run: per-target setup tests
complete before ordinary units dispatch, each worker is bound to one target and
executes one unit at a time, serial groups stay atomic on one worker, and a
worker is discarded after any failing unit or infrastructure fault. Results
stream back as they happen and the report orders them independently of
completion time.

Workers are normally separate processes; each re-loads the config module and
owns one driver instance (one browser). A programmatic in-memory config (the
`rawConfig` option) cannot cross a process boundary, so it runs against a
single in-process worker instead — same scheduler, same execution core, only
the transport differs.

## Agent configuration

There is no implicit default model. Configure one of:

```ts
export default defineConfig({
  agent: { model: 'anthropic/claude-sonnet-4.5' },
});
```

```bash
E2E_MODEL=openai/gpt-5.4-mini E2E_MODEL_API_KEY=... e2e run
```

```ts
// Any AI SDK provider instance works: install the provider package and pass
// the model directly. The instance owns its own transport and credentials.
import { openai } from '@ai-sdk/openai';

export default defineConfig({
  agent: { model: openai('gpt-5.4-mini') },
});
```

A `provider/model-id` string is reached through the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway), so the provider is
chosen by the model string. The gateway credential is read from
`E2E_MODEL_API_KEY` (or `agent.model.apiKeyEnv`, falling back to
`AI_GATEWAY_API_KEY`) and never enters config digests, logs, or reports.
`agent.model.endpoint` overrides the gateway base URL and must use HTTPS
unless it is a loopback host, which is how a local or self-hosted
OpenAI-compatible endpoint is reached.

A model instance bypasses the gateway entirely: `openai(...)`,
`anthropic(...)`, `ollama(...)`, or any other package implementing the AI SDK
language-model specification is used as-is, with whatever credentials and
endpoint the provider package resolves itself. Because workers re-load the
config module, each process constructs its own instance; the report records
the instance's provider and model ID.

Model input is the redacted semantic tree, the bounded prior-step ledger, and
trusted project context — never screenshots, raw HTML, cookies, headers, or
secret values. Secure fields arrive masked and registered secret values are
replaced by their secret name.

Two behaviors are worth knowing when writing tests:

- `agent.extract` projects your schema to JSON Schema when the vendor supports
  it, so zod schemas are enforced by the provider in one model call. Vendors
  without a converter fall back to text mode: describe the shape in the
  instruction, and rejections feed validation issue paths back for one repair
  attempt within `maxModelCalls`.
- Any secret fill leaves the viewport pixel-tainted for the rest of the attempt,
  so `agent.assert` stops attaching screenshot evidence afterwards.

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
