# e2e with Next.js

A one-page Next.js App Router demo app with an e2e suite: three tests that use
locators only, and two that hand a step to an agent and then check the result
with a locator.

## Run it

```bash
npm install
npm run test:e2e
```

The runner starts `npm run dev` and waits for `http://localhost:3100` to
answer. If the dev server is already running, it reuses it. The first run
downloads Chromium.

The agent tests skip themselves without a model key. To run them, set a
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key, or swap the
model in `e2e.config.ts` for [another provider](https://e2e.tester.army/docs/models):

```bash
AI_GATEWAY_API_KEY=... npm run test:e2e
```

## What e2e adds to a Next.js app

| File | What it does |
| --- | --- |
| `package.json` | `e2e`, `@e2e-dev/web`, and `playwright` as dev dependencies, plus `ai` and `zod` for the agent. The `test:e2e` script runs `e2e run`. The `dev` script pins the port. |
| `e2e.config.ts` | One web target. `app.url` is the dev server, and `app.command` starts it. `agents.default.model` is the model behind `agent.*` steps. |
| `tests/greeting.e2e.ts` | Deterministic tests with `getByRole` and `getByLabel`. |
| `tests/agent.e2e.ts` | `agent.act` and `agent.assert`, each followed by a locator check that does not depend on the model. |

The page is `app/page.tsx`, and the form is the client component in
`app/greeting-form.tsx`: a labelled name field, a Greet button, an `alert`
when the name is empty, and a `status` with the greeting. The tests query
those roles and labels, so the app needs no test ids.

## Things Next.js adds to the page

- **A second `alert`.** Next.js renders an empty `role="alert"` route
  announcer on every page, so `getByRole('alert')` matches two nodes. The
  tests narrow it with `.filter({ hasText })`.
- **The Dev Tools button.** `next dev` adds an "Open Next.js Dev Tools"
  button. Name the buttons you query, as the tests do, or run the suite
  against `npm run build && npm run start` in CI.
- **Port 3000 is often taken.** With `reuseExisting`, the runner tests
  whatever already answers on the URL, even a different app. That's why this
  example uses port 3100.

## Add e2e to your own Next.js app

```bash
npx e2e init
```

Pick **Web**. Then copy `app.command` from `e2e.config.ts` so the runner
starts the dev server for you.

Docs: [Quickstart](https://e2e.tester.army/docs/quickstart),
[Starting your app](https://e2e.tester.army/docs/starting-your-app),
[Writing tests](https://e2e.tester.army/docs/writing-tests).

Last checked with e2e 0.15.2, @e2e-dev/web 0.11.1, Next.js 16.3, and Node 22.
