# e2e

The `e2e` SDK, runner, and CLI for agentic end-to-end testing. Full
documentation: [e2e.docs.buildwithfern.com](https://e2e.docs.buildwithfern.com).

```bash
pnpm add -D e2e@beta @e2edev/playwright@beta
```

## Usage

```bash
e2e init
APP_URL=http://localhost:3000 e2e run
```

```ts
import { test, expect } from 'e2e';

test('user signs in', async ({ app, screen, web }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await screen.getByRole('button', { name: 'Sign in' }).tap();
  await expect(web).toHaveURL('/dashboard');
});
```

Missing Playwright browsers are downloaded on first run. To provision them ahead
of time (for example in a CI image), run `npx playwright install chromium`.

Run files in parallel with `--workers`, or set `workers` in the config.

## Agent steps

Deterministic tests need no model. Agent steps — `agent.tap`, `click`, `type`,
`longPress`, `scroll`, `scrollTo`, `waitFor`, `extract`, and `assert` — require
one:

```ts
export default defineConfig({
  agent: { model: 'anthropic/claude-sonnet-4.5' },
});
```

```bash
E2E_MODEL=openai/gpt-5.4-mini E2E_MODEL_API_KEY=... e2e run
```

A `provider/model-id` string goes through the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway). To use a provider
directly, pass any AI SDK model instance instead:

```ts
import { openai } from '@ai-sdk/openai';

export default defineConfig({
  agent: { model: openai('gpt-5.4-mini') },
});
```

Screenshots, raw HTML, cookies, headers, and registered secret values are never
sent to the model.

The adaptive trace cache (`trace-1`) replays a passing `agent.act()` step's
recorded actions zero-turn on the next run, diverging to the live agent
mid-step whenever the app no longer matches the recording. It is on by
default (`read-write`; CI is forced to `read-only`) — opt out with
`cache: 'off'` or per run with `--no-cache`. Entries live under
`.e2e/cache/` or in any custom `TraceCacheStore`. Judgments (`assert`,
`waitFor`, `extract`) are never cached — every judgment is made fresh, per
run, from a fresh observation.

## Current limitations

- `agent.act` structured output (`options.schema`) and vision evidence
  (`options.vision`) reject with `UNSUPPORTED_CAPABILITY`.
- The HTML reporter and video artifacts are not available.
- Reported steps carry no source locations.
- iOS and Android targets are rejected.

## Contributing

See [CONTRIBUTING.md](https://github.com/tester-army/e2e/blob/main/CONTRIBUTING.md).
