# e2e

The open-source, cross-platform, agentic testing framework. One test runs
on web, iOS, and Android.

**The last testing framework you will ever need.**

```bash
pnpm add e2e
```

```ts
import { test } from 'e2e';

export default test('user can sign up', async ({ app, agent }) => {
  await app.open();

  await agent.act('sign up as a new user');

  await agent.assert('the dashboard is visible');
});
```

```bash
npx e2e run
```

## Why

There is no cross-platform testing framework built on agentic testing.
Playwright owns web. Detox and Maestro fragment mobile. AI testing tools are
web-only libraries bolted onto other runners. `e2e` is one API for all of
it: full deterministic parity for migrators (locators, network
interception, gestures, app lifecycle — see
[spec/12-migration.md](./spec/12-migration.md)), and agentic testing as the
reason to switch.

The approach mirrors how Vitest built on Vite: reuse a great engine,
innovate on the layer above. `e2e` ships Playwright as its default web
driver and focuses where no automation engine aims — agent-native
execution, one API across platforms, and managed resources. A test describes a **user workflow**; a **target** decides
where it runs. Write it once; run it on web, iOS, and Android.

And the messy parts of real E2E — test accounts, secrets — are first-class
resources, not plumbing:

```ts
import { test, credentials } from 'e2e';

export default test('admin can invite a teammate', async ({ app, agent }) => {
  await app.open();

  await agent.login(credentials.user('admin')); // secret never enters the model

  await agent.act('invite a teammate as viewer', {
    email: 'ada@example.test',
  });

  await agent.assert('the pending invite is listed');
});
```

The same resource model extends to email inboxes (OTP/magic-link
extraction), webhook captures, files, and phone numbers — shipped as
extensions after the core.

- **A control gradient, not a mode switch** — `agent.act('goal')` plans a flow; `agent.tap('the login button')` uses AI only to locate (cached); `screen.getByRole('button', { name: 'Login' }).tap()` is zero-AI. All three tiers are cross-platform.
- **Testing Library on every platform** — `screen` projects role/label/text/testId queries onto ARIA (web) and native accessibility (iOS/Android). One deterministic layer, shared primitives, native implementations — the React Native way.
- **Deterministic where it counts** — instant-action locations cache as readable `screen` queries; world-state assertions are always deterministic; the cache is committable and reviewable.
- **Cross-platform** — one test, many targets: `npx e2e run --target ios`.
- **Bring your own backend — or your own platform** — automation backends are separate packages on a public driver SPI. Playwright is just the default web driver; if something 100× faster ships tomorrow, it's `npm install` + one config line. And the platform set is open: an `e2e-driver-electron` package makes `electron` a first-class target, no core release needed. Community drivers welcome: `e2e-driver-*`.
- **Local-first** — runs offline and in CI with no account. [TesterArmy Cloud](https://tester.army) is one config switch for managed browsers and devices, resources, and replays.

## Roadmap

- **Service emulation** — local, stateful Stripe/Slack/OAuth emulators with assertions: `expect(stripe).toHavePayment(…)`
- **PR testing** — preview-URL resolution, changed-file test selection, exploratory `test.dynamic`, GitHub Checks
- **More resources** — webhook captures, file fixtures, phone/SMS
- **Runner niceties** — `test.each`, sharding, watch mode (`e2e dev`), inspector (`e2e open`), visual snapshots

## Status

Spec phase — see [RFC.md](./RFC.md) for the one-page case,
[spec/](./spec) for the full API specification,
[spec/roadmap/](./spec/roadmap) for deferred designs, and [PLAN.md](./PLAN.md)
for the implementation plan.

---

by [TesterArmy](https://tester.army)
