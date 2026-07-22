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
web-only libraries bolted onto other runners. `e2e` is the successor
category: a test describes a **user workflow** — executed by an agent,
pinned down deterministically where you choose — and a **target** decides
where it runs. Write it once; run it on web, iOS, and Android.

And the messy parts of real E2E — email verification codes, test accounts,
webhooks — are first-class resources, not plumbing:

```ts
import { test, email } from 'e2e';

export default test('email signup works', async ({ app, agent }) => {
  const inbox = email.inbox('signup');

  await app.open();

  await agent.act('create an account using this email', {
    email: inbox.address,
  });

  const code = await inbox.code({ from: 'noreply@example.com' });

  await agent.act('enter the verification code', { code });

  await agent.assert('the user is signed in and sees the dashboard');
});
```

- **A control gradient, not a mode switch** — `agent.act('goal')` plans a flow; `agent.tap('the login button')` uses AI only to locate (cached); `screen.getByRole('button', { name: 'Login' }).tap()` is zero-AI. All three tiers are cross-platform.
- **Testing Library on every platform** — `screen` projects role/label/text/testId queries onto ARIA (web) and native accessibility (iOS/Android). One deterministic layer, shared primitives, native implementations — the React Native way.
- **Deterministic where it counts** — instant-action locations cache as readable `screen` queries; resource assertions like `expect(inbox).toHaveEmail(…)` are always deterministic; the cache is committable and reviewable.
- **Cross-platform** — one test, many targets: `npx e2e run --target ios`.
- **Bring your own backend** — automation backends are separate packages on a public driver SPI. Playwright is just the default web driver; if something 100× faster ships tomorrow, it's `npm install` + one config line. Community drivers welcome: `e2e-driver-*`.
- **Local-first** — runs offline and in CI with no account. [TesterArmy Cloud](https://tester.army) is one config switch for managed browsers and devices, inboxes, and replays.

## Roadmap

- **Service emulation** — local, stateful Stripe/Slack/OAuth emulators with assertions: `expect(stripe).toHavePayment(…)`
- **PR testing** — preview-URL resolution, changed-file test selection, exploratory `test.dynamic`, GitHub Checks
- **Phone/SMS resources**, visual snapshots, custom drivers

## Status

Spec phase — see [spec/](./spec) for the full API specification,
[spec/roadmap/](./spec/roadmap) for deferred designs, and [PLAN.md](./PLAN.md)
for the implementation plan.

---

by [TesterArmy](https://tester.army)
