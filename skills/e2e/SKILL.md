---
name: e2e
description: Set up and write end-to-end tests with e2e, the @e2edev/e2e runner. Covers scaffolding e2e.config.ts, choosing the Playwright browser engine or the agent-device mobile engine, starting the app under test from the config, writing tests that mix deterministic screen, app, web, and expect calls with bounded agent.act, agent.assert, agent.waitFor, and agent.extract steps, running them with the e2e CLI, and reading .e2e/report.json when a run fails. Use when a project depends on @e2edev/e2e, when asked to add end-to-end, browser, mobile, or agentic UI tests, or when an e2e run fails.
---

# e2e: end-to-end tests in TypeScript, with bounded agent steps

e2e is a local-first end-to-end test runner. Tests are plain TypeScript.
Deterministic calls (`screen`, `app`, `web`, `expect`) do exactly what they
say and make no model calls. Agent calls (`agent.act`, `agent.assert`,
`agent.waitFor`, `agent.extract`) hand one goal or one question to a model
under a deadline and a call budget. The runner knows no platform: every
target names an engine, `@e2edev/playwright` for browsers or
`@e2edev/agent-device` for iOS simulators and Android emulators.

```ts
// e2e.config.ts
import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { playwright } from '@e2edev/playwright';

export default {
  targets: [
    {
      engine: playwright({
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], log: '.e2e/logs/app.log' },
      }),
    },
  ],
  // Only needed for agent.* steps; the model comes from E2E_MODEL.
  agents: { default: createAgent({ system: 'You are a thorough QA agent. Verify every outcome on screen.' }) },
} satisfies E2EConfig;
```

```ts
// tests/billing.e2e.ts
import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

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
`npx --no-install e2e guide <topic>` (`e2e guide` alone prints this page).

| Topic | File | Read it when |
| --- | --- | --- |
| `setup` | [references/setup.md](references/setup.md) | Adding e2e to a project, writing `e2e.config.ts`, starting the app from the config, mobile targets |
| `writing-tests` | [references/writing-tests.md](references/writing-tests.md) | Writing or fixing tests: fixtures, locators, actions, matchers, sign-in sessions, the `web` fixture |
| `agent` | [references/agent.md](references/agent.md) | Adding `agent.*` steps, picking a model, cost and budgets, the trace cache |
| `running` | [references/running.md](references/running.md) | CLI flags, reporters, `.e2e/report.json`, exit codes, CI |
| `debugging` | [references/debugging.md](references/debugging.md) | A run failed: error codes and their fixes, `--headed`, `--debug`, `--ai-trace` |

## Workflow

1. Look at what exists: `e2e.config.ts` or `e2e.config.mts`, the `tests` glob
   (default `tests/**/*.e2e.ts`), `@e2edev/e2e` in `package.json`. Nothing
   there: follow `setup`.
2. Learn the screens you will drive before writing a test: routes, labels,
   roles, button text. Semantic locators need the accessible names the app
   renders, so read the templates or components, or open the page with
   `--headed`.
3. Write `tests/<feature>.e2e.ts`. Deterministic steps first. One `agent.act`
   per goal where the flow varies, and an `expect` on its outcome right after.
4. Run one file: `npx --no-install e2e run tests/<feature>.e2e.ts`. Agent
   steps need `E2E_MODEL=provider/model-id` and `E2E_MODEL_API_KEY` in the
   environment; deterministic tests need neither.
5. Read the failure: the reporter prints the error code, the message, and a
   code frame; `.e2e/report.json` has every step and artifact path. Fix the
   locator, the expectation, or the app. Never add a sleep.

## Rules

- Run the CLI as `npx --no-install e2e ...` (or `pnpm exec e2e ...`), so npx
  never fetches a different package.
- The config is `export default { ... } satisfies E2EConfig` with
  `import type { E2EConfig } from '@e2edev/e2e'`. `targets` is required and
  each target names its engine. The engine declares the app:
  `playwright({ url, command })`. There is no top-level `app` key and no
  `defineConfig`.
- Import `test`, `expect`, and `credentials` from `@e2edev/e2e`. A test that
  uses the `web` fixture imports `test` from `@e2edev/playwright` instead: the
  same runtime `test`, typed with `web`.
- Config and tests are ES modules and load as such whatever `package.json` sets as `type`.
- Nothing waits explicitly: queries poll, actions wait, `expect` retries.
  Reads such as `textContent()` and `count()` do not retry, so assert with a
  matcher when a value has to settle.
- A locator that matches two nodes fails with `LOCATOR_AMBIGUOUS`. Narrow it
  with `{ name }`, `filter()`, `first()`, `nth()`, or `{ visible: true }`.
- Secrets never appear in test code. Declare `credentials` in the config,
  resolve with `credentials.user(name)`, and hand `.password` (an opaque
  `Secret`) only to `fill()` or to `agent.act` params.
- Agent instructions: one goal per `act`, the wording on screen, real values
  in params. Judge meaning, not phrasing: `toContain('Pro')`, not an exact
  sentence a model produced.
- Prefer `expect` for anything mechanical. Agent calls cost tokens and time;
  spend them on the step whose wording or path varies.
- `.e2e/` is output (`report.json`, `artifacts/`, `cache/`, `logs/`). Read it,
  never edit it.
