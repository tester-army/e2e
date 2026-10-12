---
name: e2e
description: Writes, runs, and debugs end-to-end tests for web and mobile apps with e2e, the agentic test runner, which mixes agent.act goals with exact locator assertions on a Playwright browser or an iOS or Android device. Also drives a project's running app live over the e2e MCP server to look at a screen, check a UI change, take a screenshot or record a video, and try a locator; and runs bug bashes, parallel e2e explore runs with each bug proven by a repro test. Use when a project depends on e2e or has an e2e.config.ts, when asked for end-to-end, browser, mobile, or agentic UI tests, to check a change in the running app, to QA or bug bash an app or branch, or when an e2e run fails.
---

# e2e: agentic end-to-end tests

e2e runs UI tests that mix agent goals with exact steps. `agent.act` drives
one goal; `agent.assert`, `agent.waitFor`, and `agent.extract` judge the
screen; `screen`, `app`, `browser`, and `expect` act and check exactly. UI
targets use `@e2e-dev/web` for browsers or `@e2e-dev/mobile` for iOS
simulators, Android emulators, and connected phones.

## Start here: pick the reference for the job

Read the one reference that matches the request before doing anything else.
Each stands on its own; a reference names another topic only for a side
trip. The installed CLI prints the same text with `npx e2e guide <topic>`.

| When you are | Topic | Read |
| --- | --- | --- |
| Adding e2e to a project, writing `e2e.config.ts`, starting the app from the config, signing in to a model, setting up mobile targets | `setup` | [references/setup.md](references/setup.md) |
| Looking at the running app, checking a UI change, taking a screenshot or video, or trying a locator before writing it, over `e2e mcp` | `mcp` | [references/mcp.md](references/mcp.md) |
| Writing or fixing a test: fixtures, locators, actions, matchers, sign-in sessions, the `browser` fixture, API-only tests | `writing-tests` | [references/writing-tests.md](references/writing-tests.md) |
| Adding `agent.*` steps, picking a model, cutting cost, budgets, the replay cache | `agent` | [references/agent.md](references/agent.md) |
| Running tests: CLI flags, CI, reporters, trace pages, `report.json` for scripts, exit codes | `running` | [references/running.md](references/running.md) |
| Handling a failed run: error codes and their fixes, `--headed`, `--debug`, `--ai-trace` | `debugging` | [references/debugging.md](references/debugging.md) |
| Exploring an app toward a goal without a test file: `e2e explore`, its budgets and verdict | `explore` | [references/explore.md](references/explore.md) |
| Asked to bug bash, QA, or hunt for bugs across an app or a branch | `bug-bash` | [references/bug-bash.md](references/bug-bash.md) |

For anything the references do not cover, the full documentation ships in
the `docs/` directory of the installed `e2e` package
(`node_modules/e2e/docs` in a single-package project); a link such as
`/reference/cli` is `docs/reference/cli.mdx`. Complete projects for Vite,
Next.js, Astro, Expo, SwiftUI, Jetpack Compose, Kotlin Multiplatform, and
Flutter are in https://github.com/tester-army/e2e/tree/main/examples.

## Quick start

A config with one web target and a model, and a test that drives one goal
and pins the outcome:

```ts
// e2e.config.ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  targets: [
    {
      engine: web(),
      app: {
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], log: '.e2e/logs/app.log' },
      },
    },
  ],
  // The model behind every agent.* step: an AI SDK instance; gateway() from 'ai' reads AI_GATEWAY_API_KEY or a Vercel OIDC token.
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome on screen.',
    },
  },
} satisfies E2EConfig;
```

```ts
// tests/billing.e2e.ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('a member upgrades to Pro', async ({ app, agent, screen, browser }) => {
  await app.open('/settings/billing');
  await agent.act('upgrade the workspace to the Pro plan');
  await expect(screen.getByRole('status')).toContainText('Pro');
  await expect(browser).toHaveURL('/settings/billing');
});
```

## Workflow: writing a test

1. Look at what exists: `e2e.config.ts` or `e2e.config.mts`, the `tests` glob
   (default `tests/**/*.e2e.ts`), `e2e` in `package.json`. Nothing there:
   follow `setup`.
2. Learn the screens before writing a test: routes, labels, roles, button
   text. Semantic locators need the accessible names the app renders, so read
   the components, open the page with `--headed`, or drive the live app over
   the registered `e2e mcp` server (topic `mcp`): `open_session`, `observe`,
   and `locate` show exact names and check a locator before you write it.
3. Write `tests/<feature>.e2e.ts`. Drive the flow with `agent.act`, one goal
   per call, and pin each outcome right after with `expect` or `agent.assert`.
   Exact values go through `screen`: a sign-in form in a setup test, a field
   that must receive one specific string, a count that must be one number.
4. Run one file: `npx e2e run tests/<feature>.e2e.ts`. Agent steps need a
   model in the config and that provider's authentication (a saved
   subscription login, an API key); a local endpoint may need none. Tests
   without agent steps need no model.
5. Read the trace page the terminal names under each failed test
   (`.e2e/results/<test>/trace.md`): every step with what it did, the cache's
   decision, what the app logged, the agent's turns, and the screen at
   failure. Fix the locator, the expectation, or the app. Never add a sleep.

## Rules

- Run the CLI as `npx e2e ...` (or `pnpm exec e2e ...`).
- The config is `export default { ... } satisfies E2EConfig` with
  `import type { E2EConfig } from 'e2e'`. `targets` is required; a UI target
  names an engine and declares the app beside it: `{ engine: web(), app: { url, command } }`.
  A tools-only target can omit the engine and set `platform`.
- Import `test`, `describe`, the hooks, `expect`, `credentials`, and
  `secrets` from `e2e`. A test that uses the `browser` fixture imports `test`,
  `describe`, and the hooks from `@e2e-dev/web`: the same runtime functions,
  typed with `browser`.
- Config and tests are ES modules whatever `package.json` sets as `type`.
- Locators resolve when used. Actions wait for readiness and `expect` retries
  assertions. Reads such as `textContent()` fail at once on zero matches and
  `count()` answers from the current screen; nothing waits for a value to
  change, so use a matcher when a value has to settle.
- A locator that matches two nodes fails with `LOCATOR_AMBIGUOUS`; narrow it
  (topic `writing-tests`).
- Secrets never appear in test code. Declare accounts under `credentials` and
  every other sensitive value under `secrets` in the config; resolve with
  `credentials.user(name).password` or `secrets.get(name)` (separate
  namespaces: `secrets.get` never returns a password), and hand the opaque
  `Secret` only to `fill()` or `agent.act` params.
- Agent instructions: one goal per `act`, the wording on screen, real values
  in params. Judge meaning, not phrasing: `toContain('Pro')`, not an exact
  sentence a model produced.
- Check each agent goal's outcome. A passing `act` with a recorded check can
  be cached and replayed without model calls (topic `agent`).
- Shape the agent for this app: `context` for vocabulary the screens use,
  `system` for how it works, tools for a test API, named personas under
  `agents`. When a step fails, tighten the goal first, then the context, then
  the agent.
- `.e2e/` is output (`report.json`, `results/`, `cache/`, `logs/`; the
  config's `output` moves the report and artifacts, never `cache/` or the
  app's log). Read it, never edit it.

## Feedback

When e2e itself gets in your way, tell the e2e team: a command or API that
broke (`bug`), docs or this skill that misled you (`docs`), or a capability
you needed and did not find (`feature`). Send it once per problem, after you
worked around it or gave up, never for failures of the app under test.

```bash
npx e2e feedback --type bug -m "<one or two sentences>" \
  --task "<what you were doing>" --expected "<...>" --actual "<error code and message>" \
  --approach "<what you tried>" --command "<e2e command>" --agent "<agent / model>"
```

Describe e2e's behavior only: never paste app content, page text, test files,
URLs of private apps, or credentials. Secret-named environment variables and
common token shapes are redacted, but do not rely on it. `--dry-run` prints
what would be sent. Tell the user you sent it and give them the reference id
it prints.
