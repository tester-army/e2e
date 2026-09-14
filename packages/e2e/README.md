# e2e

The `e2e` SDK, runner, and CLI for agentic end-to-end testing. Full
documentation: [e2e.mintlify.app](https://e2e.mintlify.app).

```bash
pnpm dlx e2e init
```

## Usage

```bash
APP_URL=http://localhost:3000 npx e2e run
```

Init adds the runner to `devDependencies`, offers Playwright or agent-device
as the engine and AI SDK v7 for the built-in agent, then asks whether to
install. Choose Playwright for the config and browser test below. `--yes`
skips the prompts: Playwright, AI on, no installation.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';

export default {
  targets: [{ name: 'web', engine: playwright({ url: process.env.APP_URL ?? 'http://localhost:3000' }) }],
} satisfies E2EConfig;
```

The engine declares the app it drives: the URL is an option of `playwright()`,
not a config key, and a device engine names a bundle id instead. Or let the
runner start the whole stack itself: the dependencies as `services`, then the
app as `command`:

```ts title="e2e.config.ts"
export default {
  targets: [
    {
      name: 'web',
      engine: playwright({
        url: 'http://127.0.0.1:3000',
        services: [
          {
            executable: 'docker',
            args: ['compose', 'up', '--wait', 'postgres'],
            waitForExit: true,
            teardown: { executable: 'docker', args: ['compose', 'down'] },
          },
          { executable: 'pnpm', args: ['db:migrate'], waitForExit: true },
        ],
        command: { executable: 'pnpm', args: ['dev'], startupTimeout: 120_000 },
      }),
    },
  ],
} satisfies E2EConfig;
```

Services start one at a time in declaration order, each ready before the next
starts (a `waitForExit` service is ready when it exits 0, otherwise its
`readyUrl` must answer), and `command` only starts once the last service is
ready. On every exit path the runner stops the app, then stops the services in
reverse order, then runs their `teardown` commands in reverse order, so
`docker compose down` runs after the migration step and the app are gone.
Every service option is listed under
[services](https://e2e.mintlify.app/reference/config#services).

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
is still written; set `command.log: '.e2e/logs/app.log'` to keep what the
server printed, since its output is otherwise discarded. Every option is listed under
[the app under test](https://e2e.mintlify.app/reference/config#the-app-under-test).

```ts
import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('user signs in', async ({ app, screen, web }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await screen.getByRole('button', { name: 'Sign in' }).tap();
  await expect(web).toHaveURL('/dashboard');
});
```

The runner itself knows no platform: every target names the engine that
drives it, and `@e2edev/playwright` is the browser one. Missing Playwright
browsers are downloaded once, on the first run, before the run's clock starts.
To provision them ahead of time (for example in a CI image), run
`npx playwright install chromium`.

Run files in parallel with `--workers`, or set `workers` in the config.

## Agent steps

Deterministic tests need no model. Agent steps — `agent.act`, `assert`,
`waitFor`, and `extract` — require one:

```ts
import { gateway } from 'ai';

export default {
  agents: { default: { model: gateway('anthropic/claude-sonnet-4.5') } },
} satisfies E2EConfig;
```

```bash
AI_GATEWAY_API_KEY=... e2e run
```

The model is an AI SDK instance the config constructs; the runner has no
gateway of its own. `gateway()` from `ai` is the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway), `openrouter()` from
`@openrouter/ai-sdk-provider` is [OpenRouter](https://openrouter.ai), and
`createOpenAICompatible()` from `@ai-sdk/openai-compatible` reaches any
endpoint speaking the OpenAI chat API. A provider's own package calls it
directly:

```ts
import { openai } from '@ai-sdk/openai';

export default {
  agents: { default: { model: openai('gpt-5.6-luna') } },
} satisfies E2EConfig;
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

`e2e run --video` records every attempt: a WebM screencast of the page under
the attempt's artifact directory, named in the failure recap.
`artifacts: ['screenshot', 'trace', 'video']` turns it on for every run, and
`artifacts: { kinds: ['screenshot', 'trace', 'video'], video: { retain:
'on-failure' } }` keeps only the recordings of attempts that did not pass.

## Coding agents

`e2e init` installs a skill, `SKILL.md` plus one file per topic, into
`.agents/skills/e2e/` (read by Codex, Cursor, Copilot, Gemini CLI, OpenCode,
Zed, and most other agents) and `.claude/skills/e2e/` (Claude Code), so an
agent working in the project knows how to configure e2e, write tests, and
read a failing run. `npx skills add tester-army/e2e` installs the same skill
from the repository. An agent without it can print the text:

```bash
npx e2e guide                # the overview and the topic list
npx e2e guide writing-tests  # one topic
```

## Current limitations

- The HTML reporter is not available.
- Reported steps carry no source locations.

## Contributing

See [CONTRIBUTING.md](https://github.com/tester-army/e2e/blob/main/CONTRIBUTING.md).
