# Roadmap — Service Emulation

> **Status: roadmap.** Not part of the v0 spec. This draft predates several
> core-API changes and will be re-validated before adoption.

Real E2E tests are hard because of the world around the app: Stripe, Slack,
OAuth, webhooks, email. `e2e` ships local, stateful service emulators with
first-class assertions, so complete SaaS workflows are testable offline and
in CI.

Never called "mocks" in docs or API. They are **services** (emulated locally,
managed in Cloud).

## Access

Via the `services` fixture (preferred) or the `e2e/services` subpath:

```ts
export default test('checkout posts Slack alert', async ({ app, agent, services }) => {
  const stripe = services.stripe();
  const slack = services.slack();
  // …
});
```

Service handles are lazy singletons per test run: `services.stripe()` returns
the same instance everywhere in a test.

## How the app connects

Emulators are API-compatible with the real services where feasible. The app
under test points its SDKs at the emulator via env:

```
STRIPE_API_BASE=http://127.0.0.1:12111
SLACK_API_URL=http://127.0.0.1:12112
```

`npx e2e services start` prints (and can write) these env vars. In Cloud
mode, per-run sandbox URLs are injected into the preview deployment.

## `services.stripe()`

Stateful Stripe emulator: checkout sessions, payments, subscriptions,
webhooks.

```ts
type StripeService = {
  /** Seed state before the flow runs. */
  seed(state: {
    customers?: Array<DeepPartial<StripeCustomer>>;
    products?: Array<DeepPartial<StripeProduct>>;
    prices?: Array<DeepPartial<StripePrice>>;
  }): Promise<void>;

  /** Force the next payment attempt to fail (declines, 3DS, etc). */
  failNextPayment(reason?: 'card_declined' | 'insufficient_funds' | 'requires_3ds'): Promise<void>;

  /** Inspect state (also used by matchers). */
  payments(): Promise<StripePayment[]>;
  subscriptions(): Promise<StripeSubscription[]>;

  /** Deliver a synthetic webhook event to the app. */
  sendWebhook(event: { type: string; data?: unknown }): Promise<void>;

  /** Wipe all state. */
  reset(): Promise<void>;
};
```

Matchers (see 03-assertions.md):

```ts
await expect(stripe).toHavePayment({ amount: 2900, status: 'succeeded' });
await expect(stripe).toHaveSubscription({ plan: 'pro', status: 'active' });
await expect(stripe).toHaveWebhookDelivered('checkout.session.completed');
```

Test cards work like Stripe's real test cards (`4242…` succeeds, documented
decline numbers fail) so agent instructions like "use the test card" work.

## `services.slack()`

Captures everything the app sends to Slack (webhooks + Web API).

```ts
type SlackService = {
  channel(name: string): SlackChannel;
  messages(): Promise<SlackMessage[]>;
  reset(): Promise<void>;
};

type SlackChannel = {
  name: string;
  messages(): Promise<SlackMessage[]>;
};

type SlackMessage = {
  channel: string;
  text: string;
  blocks?: unknown[];
  postedAt: Date;
};
```

```ts
await expect(slack.channel('#sales')).toHaveMessage('New subscription');
await expect(slack.channel('#alerts')).not.toHaveMessage(/error/i);
```

## `services.email()`

The delivery side of email (what your app *sends*), sharing the `Inbox` API
from 04-resources.md:

```ts
const inbox = services.email().inbox('buyer');
```

Root-level `email.inbox()` and `services.email().inbox()` are the same
resource; the root export is the convenience path.

## `services.webhooks()`

The capture resource from 04-resources.md, exposed on the fixture for
symmetry: `services.webhooks().capture('candidate-created')`.

## Lifecycle

```ts
type Services = {
  stripe(): StripeService;
  slack(): SlackService;
  email(): EmailService;
  webhooks(): WebhookService;

  /** Reset all started services. Typical use: afterEach. */
  reset(): Promise<void>;
};
```

- Declared services auto-start with `npx e2e run` (config `services` block)
  or run standalone via `npx e2e services start stripe,slack,email`.
- State isolation default: **per test file** locally, per run in CI, with
  `services.reset()` for per-test isolation.
- In Cloud mode, `resources.stripe: 'managed'` (or `'managed-per-pr'`) swaps
  in an isolated hosted sandbox with the same API.

## Canonical example

```ts
import { test, expect } from 'e2e';

export default test('checkout sends Slack alert', async ({ app, agent, services }) => {
  const stripe = services.stripe();
  const slack = services.slack();

  await app.open();
  await agent.act('buy the pro plan using the test card');

  await expect(stripe).toHavePayment({ amount: 2900, status: 'succeeded' });
  await expect(slack.channel('#sales')).toHaveMessage('New subscription');
});
```

## Roadmap services (post-v0)

GitHub API, OAuth providers (Google/Okta), Resend/SendGrid send-capture,
Twilio, AWS (S3/SES/SQS). Each must ship with: stateful emulator, seed API,
matchers, reset, and Cloud managed variant.
