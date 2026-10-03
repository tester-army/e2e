# e2e with Vite

A one-page Vite + React demo app with an e2e suite: three tests that use
locators only, and two that hand a step to an agent and then check the result
with a locator.

## Run it

```bash
npm install
npm run test:e2e
```

The runner starts `npm run dev` and waits for `http://localhost:5173` to
answer. If the dev server is already running, it reuses it. The first run
downloads Chromium.

The agent tests skip themselves without a model key. To run them, set a
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key, or swap the
model in `e2e.config.ts` for [another provider](https://e2e.tester.army/docs/models):

```bash
AI_GATEWAY_API_KEY=... npm run test:e2e
```

## What e2e adds to a Vite app

| File | What it does |
| --- | --- |
| `package.json` | `e2e`, `@e2e-dev/web`, and `playwright` as dev dependencies, plus `ai` and `zod` for the agent. The `test:e2e` script runs `e2e run`. |
| `e2e.config.ts` | One web target. `app.url` is the dev server, and `app.command` starts it. `agents.default.model` is the model behind `agent.*` steps. |
| `vite.config.ts` | Pins the dev server to port 5173 with `strictPort`, so the URL in the config is always right. |
| `tests/greeting.e2e.ts` | Deterministic tests with `getByRole` and `getByLabel`. |
| `tests/agent.e2e.ts` | `agent.act` and `agent.assert`, each followed by a locator check that does not depend on the model. |

The app is `src/App.tsx`: a heading, a labelled name field, a Greet button,
an `alert` when the name is empty, and a `status` with the greeting. The tests
query those roles and labels, so the app needs no test ids.

## Add e2e to your own Vite app

```bash
npx e2e init
```

Pick **Web**. Then copy the two things this example adds on top of what
`init` writes: `app.command` in `e2e.config.ts`, and a fixed port in
`vite.config.ts`.

Docs: [Quickstart](https://e2e.tester.army/docs/quickstart),
[Starting your app](https://e2e.tester.army/docs/starting-your-app),
[Writing tests](https://e2e.tester.army/docs/writing-tests).

Last checked with e2e 0.15.2, @e2e-dev/web 0.11.1, Vite 8.3, and Node 22.
