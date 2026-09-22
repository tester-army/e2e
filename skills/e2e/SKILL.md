---
name: e2e
description: Set up and write agentic end-to-end tests with e2e, the e2e runner. Covers scaffolding e2e.config.ts, choosing the Playwright browser engine or the agent-device mobile engine, starting the app under test from the config, writing tests that drive flows with agent.act and judge them with agent.assert, agent.waitFor, and agent.extract, pinning exact values and outcomes with screen, app, web, and expect, shaping the agent for the app (context, system prompt, tools, personas), the trace cache that replays passing steps, running with the e2e CLI, and reading .e2e/report.json when a run fails. Use when a project depends on e2e, when asked to add end-to-end, browser, mobile, or agentic UI tests, or when an e2e run fails.
---

# e2e: agentic end-to-end tests in TypeScript

e2e runs UI tests with agent goals and exact assertions. `agent.act` drives
one goal; `agent.assert`, `agent.waitFor`, and `agent.extract` judge the
screen. Use `screen`, `app`, `web`, and `expect` for exact interactions and
checks. The trace cache can replay verified actions and check their recorded
end state without a model call. Agent judgments still run live.
UI targets use `@e2edev/web` for browsers or
`@e2edev/mobile` for iOS simulators and Android emulators. A test that
takes only `app` can check an API with `fetch` and `expect`; see the
`writing-tests` topic.

Agent steps can use an existing ChatGPT, Copilot, or SuperGrok subscription,
an API key, or a local model. `e2e init` offers these choices. See
[setup](references/setup.md#subscriptions-and-api-keys) for sign-in commands.

```ts
// e2e.config.ts
import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { web } from '@e2edev/web';
import { gateway } from 'ai';

export default {
  targets: [
    {
      engine: web({
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], log: '.e2e/logs/app.log' },
      }),
    },
  ],
  // The model behind every agent.* step: an AI SDK instance; gateway() from 'ai' reads AI_GATEWAY_API_KEY.
  agents: {
    default: createAgent({
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome on screen.',
    }),
  },
} satisfies E2EConfig;
```

```ts
// tests/billing.e2e.ts
import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('a member upgrades to Pro', async ({ app, agent, screen, web }) => {
  await app.open('/settings/billing');
  await agent.act('upgrade the workspace to the Pro plan');
  await expect(screen.getByRole('status')).toContainText('Pro');
  await expect(web).toHaveURL('/settings/billing');
});
```

## Topics

Read the topic for the job before writing code. The files sit next to this
one. Without them, the installed CLI prints the same text:
`npx e2e guide <topic>` (`e2e guide` alone prints this page).

| Topic | File | Read it when |
| --- | --- | --- |
| `setup` | [references/setup.md](references/setup.md) | Adding e2e to a project, writing `e2e.config.ts`, starting the app from the config, mobile targets |
| `writing-tests` | [references/writing-tests.md](references/writing-tests.md) | Writing or fixing tests: fixtures, locators, actions, matchers, sign-in sessions, the `web` fixture |
| `agent` | [references/agent.md](references/agent.md) | Adding `agent.*` steps, picking a model, cost and budgets, the trace cache |
| `running` | [references/running.md](references/running.md) | CLI flags, reporters, `.e2e/report.json`, exit codes, CI |
| `explore` | [references/explore.md](references/explore.md) | Exploring an app toward a goal without a test file: `e2e explore`, its budgets, verdict, and `run.explore` |
| `debugging` | [references/debugging.md](references/debugging.md) | A run failed: error codes and their fixes, `--headed`, `--debug`, `--ai-trace` |
| `mcp` | [references/mcp.md](references/mcp.md) | Driving the live app from a coding agent over MCP: `e2e mcp`, its tools, and the explore-then-write loop |

## Workflow

1. Look at what exists: `e2e.config.ts` or `e2e.config.mts`, the `tests` glob
   (default `tests/**/*.e2e.ts`), `e2e` in `package.json`. Nothing
   there: follow `setup`.
2. Learn the screens you will drive before writing a test: routes, labels,
   roles, button text. Semantic locators need the accessible names the app
   renders, so read the templates or components, open the page with
   `--headed`, or drive the live app through the `e2e mcp` server when it is
   registered (topic `mcp`): `open_session`, `observe`, and `locate` show the
   exact names and check a locator before you write it.
3. Write `tests/<feature>.e2e.ts`. Drive the flow with `agent.act`, one goal
   per call, and pin each outcome right after with `expect` or
   `agent.assert`. Exact values go through `screen` directly: a sign-in form
   in a setup test, a field that must receive one specific string, a count
   that must be one specific number.
4. Run one file: `npx e2e run tests/<feature>.e2e.ts`. Agent steps need a
   model in the config and authentication for its provider, such as a saved
   subscription login or `AI_GATEWAY_API_KEY` for `gateway()`. A local
   endpoint may need no key. Tests without agent steps need no model.
5. Read the failure: the reporter prints the error code, the message, and a
   code frame; `.e2e/report.json` has every step and artifact path. Fix the
   locator, the expectation, or the app. Never add a sleep.

## Rules

- Run the CLI as `npx e2e ...` (or `pnpm exec e2e ...`).
- The config is `export default { ... } satisfies E2EConfig` with
  `import type { E2EConfig } from 'e2e'`. `targets` is required and
  UI targets name an engine. The engine declares the app, for example
  `web({ url, command })`. A tools-only target can omit the engine
  and set `platform` explicitly. There is no top-level `app` key or `defineConfig`.
- Import `test`, `expect`, `credentials`, and `secrets` from `e2e`. A test that
  uses the `web` fixture imports `test` from `@e2edev/web` instead: the
  same runtime `test`, typed with `web`.
- Config and tests are ES modules and load as such whatever `package.json` sets as `type`.
- Locators resolve when used. Actions wait for readiness and `expect`
  retries assertions. Reads such as `textContent()` and `count()` answer from
  the current screen: a frame that is not in the document counts as zero
  matches, a stale node is re-resolved, and nothing waits for a value to
  change, so use a matcher when a value has to settle.
- A locator that matches two nodes fails with `LOCATOR_AMBIGUOUS`. Narrow it
  with `{ name }`, `filter()`, `first()`, `nth()`, or `{ visible: true }`.
- Secrets never appear in test code. Declare accounts under `credentials`
  and every other sensitive value (API keys, tokens) under `secrets` in the
  config; resolve with `credentials.user(name).password` or
  `secrets.get(name)`, and hand the opaque `Secret` only to `fill()` or to
  `agent.act` params.
- Agent instructions: one goal per `act`, the wording on screen, real values
  in params. Judge meaning, not phrasing: `toContain('Pro')`, not an exact
  sentence a model produced.
- Check each agent goal's outcome. A passing `act` with a recorded check
  can be cached and replayed without model calls. If replay fails, the
  runner can return to the live agent.
- Shape the agent for this app and keep iterating on it: `context` for
  vocabulary the screens use, `system` on `createAgent` for how it works,
  tools for a test API, and named personas under `agents`. When a step
  fails, tighten the goal first, then the context, then the agent. Topic
  `agent` has the loop.
- `.e2e/` is output (`report.json`, `artifacts/`, `cache/`, `logs/`). Read it,
  never edit it.
