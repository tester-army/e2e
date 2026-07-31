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

Resolved agent steps are cached under `.e2e/cache/` as readable queries, so a
repeat run replays the query instead of calling the model. Set the policy with
`agent.cache` (`off`, `read-only`, `read-write`) or per call with
`{ cache: false }`.

## Current limitations

- `agent.login` rejects with `UNSUPPORTED_CAPABILITY`; `agent.act` accepts a
  `Secret` parameter and covers sign-in flows.
- `agent.act` records path guidance, which is advisory: it reduces wrong turns,
  not model calls, and declining it never fails a flow.
- `CACHE_REPLAY_DIVERGED` and `AUTHENTICATION_FAILED` are in the error taxonomy
  but unreachable: nothing replays cached actions blindly, and `agent.login` is
  not implemented.
- The HTML reporter and video artifacts are not available.
- Reported steps carry no source locations.
- iOS and Android targets are rejected.

## Contributing

See [CONTRIBUTING.md](https://github.com/tester-army/e2e/blob/main/CONTRIBUTING.md).
