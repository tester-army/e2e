# e2e

The `e2e` SDK, runner, and CLI for agentic end-to-end testing. Full
documentation: [e2e.docs.buildwithfern.com](https://e2e.docs.buildwithfern.com).

```bash
pnpm dlx @e2edev/e2e@beta init
```

## Usage

```bash
APP_URL=http://localhost:3000 npx --no-install e2e run
```

Init adds the runner to `devDependencies`, offers Playwright or agent-device
as the backend and AI SDK v7 for the built-in agent, then asks whether to
install. Choose Playwright for the config and browser test below. `--yes`
skips the prompts: AI on, no backend, no installation.

```ts title="e2e.config.ts"
import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  targets: [{ name: 'web', platform: 'web', backend: playwright({ url: process.env.APP_URL ?? 'http://localhost:3000' }) }],
});
```

The backend declares the app it drives: the URL is an option of `playwright()`,
not a config key, and a device backend names a bundle id instead. Or let the
runner start the app itself:

```ts title="e2e.config.ts"
export default defineConfig({
  targets: [
    {
      name: 'web',
      platform: 'web',
      backend: playwright({
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], startupTimeout: 120_000 },
      }),
    },
  ],
});
```

The runner spawns the command, waits until `readyUrl` (defaults to `url`)
answers with a 200-499 status, and terminates it when the run finishes, fails,
or is interrupted with Ctrl-C, so no wrapper script that boots and kills the dev
server is needed. On macOS and Linux the command runs as its own process group
and the whole group is signalled; on Windows only the launched process is
signalled, so point `executable` at the server itself rather than a wrapper. A
third Ctrl-C exits immediately without teardown. The child inherits only `PATH`, `HOME`, and the
temp-directory variables plus `command.env`, so anything else the app needs,
secrets included, must be passed explicitly through `command.env`. If the app
never becomes ready the run fails with `APP_UNREACHABLE` and `.e2e/report.json`
is still written. Every option is listed under
[the app under test](https://e2e.docs.buildwithfern.com/reference/config#the-app-under-test).

```ts
import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('user signs in', async ({ app, screen, web }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await screen.getByRole('button', { name: 'Sign in' }).tap();
  await expect(web).toHaveURL('/dashboard');
});
```

The runner itself knows no platform: every target names the backend that
drives it, and `@e2edev/playwright` is the browser one. Missing Playwright
browsers are downloaded on first run. To provision them ahead of time (for
example in a CI image), run `npx playwright install chromium`.

Run files in parallel with `--workers`, or set `workers` in the config.

## Agent steps

Deterministic tests need no model. Agent steps — `agent.act`, `assert`,
`waitFor`, and `extract` — require one:

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
mid-step whenever the app no longer matches the recording, or whenever the
recorded actions ran but the recorded end state is not on screen again. An
entry is written only after a later assertion confirms the step's outcome. It
is on by default (`read-write`; CI forces the file store to `read-only`, while
a host-supplied store keeps its configured mode) — opt out with
`cache: 'off'` or per run with `--no-cache`. Entries live under
`.e2e/cache/` or in any custom `TraceCacheStore`. Judgments (`assert`,
`waitFor`, `extract`) are never cached — every judgment is made fresh, per
run, from a fresh observation.

`e2e run --ai-trace` records every model call of the run — prompt, tool
definitions, response, usage, cost — to `.e2e/ai-trace.json`, one run per
agent step, in the AI SDK devtools database shape. Open it with
[unbox-ai](https://github.com/tester-army/unbox-ai):
`npx unbox-ai .e2e/ai-trace.json`.

## Current limitations

- `agent.act` structured output (`options.schema`) and vision evidence
  (`options.vision`) reject with `UNSUPPORTED_CAPABILITY`.
- The HTML reporter and video artifacts are not available.
- Reported steps carry no source locations.
- iOS and Android need a backend package; none ships in this repo yet.

## Contributing

See [CONTRIBUTING.md](https://github.com/tester-army/e2e/blob/main/CONTRIBUTING.md).
