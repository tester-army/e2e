# 03 — Assertions

Two assertion surfaces, deliberately split:

- **`expect()`** — deterministic: UI state via `screen` locators
  (cross-platform), and eventually-consistent **world-state** via resources
  (inboxes, webhook captures).
- **`agent.assert()`** — AI judgment of the current screen, in natural
  language.

## `expect(locator)` — deterministic UI matchers

Locator matchers mirror `getByRole` state options — one semantic model for
querying and asserting, normalized per platform, working identically on
web, iOS, and Android:

```ts
await expect(screen.getByRole('heading')).toHaveText('Dashboard');
await expect(screen.getByRole('switch', { name: 'Notifications' })).toBeChecked();
```

Vocabulary: `toBeVisible`/`toBeHidden`, `toBeEnabled`/`toBeDisabled`,
`toBeChecked`, `toBeSelected`, `toBeExpanded`, `toHaveText`,
`toContainText`, `toHaveValue`, `toHaveCount`, `toHaveAccessibleName`.
Paired positives avoid double negations (`toBeDisabled` over
`not.toBeEnabled`). Deliberately absent: implementation-surface matchers
(`toHaveClass`, `toHaveAttribute`, `toHaveStyle`) — they don't exist
off-web and violate the resemble-the-user principle.

**Absence** is asserted, never queried:
`await expect(screen.getByText('Error')).not.toBeVisible()` — retried with
the negation grace window. Matcher failures print the accessibility tree
around the query scope, plus a query suggestion when a better one exists.

## `agent.assert()` — natural-language assertion

```ts
await agent.assert('the dashboard is visible');
await agent.assert('the user is signed in and sees the dashboard');
await agent.assert('no visible regressions were introduced');
```

### Signature

```ts
agent.assert(assertion: string, options?: {
  timeout?: number;     // default 30_000
  screenshot?: boolean; // attach evidence to report, default true
  soft?: boolean;       // record failure, continue the test. Default false
}): Promise<void>;
```

Semantics:

- The agent inspects the current screen (web page or native screen) and
  judges the assertion true/false.
- Failure rejects with `AssertionError` containing the agent's reasoning and
  a screenshot. The failure message must be human-readable, e.g.:

```
agent.assert: "the dashboard is visible" — FAILED
Agent saw: a login form with an error banner "Invalid verification code".
Screenshot: artifacts/signup-email/assert-1.png
```

- `agent.assert()` is bound to the current target implicitly (no target
  argument needed).

## `expect()` — resource matchers

`expect()` accepts resource handles (see 04-resources.md) and plain values —
assertions about the world outside the screen:

```ts
const inbox = email.inbox('signup');
const hook = webhook.capture('candidate-created');

await expect(inbox).toHaveEmail({ subject: /welcome/i });
await expect(hook).toHaveReceived({ payload: { name: 'Ada' } });
```

### Matcher inventory (v0)

| Subject | Matcher | Meaning |
|---|---|---|
| `inbox` | `toHaveEmail(match)` | email matching `{ from?, subject?, … }` arrived |
| `webhookCapture` | `toHaveReceived(match)` | app emitted an event with matching payload |

Service-emulation matchers (`expect(stripe).toHavePayment(…)`, Slack, …) are
roadmap — see roadmap/service-emulation.md.

Resource matchers are **eventually-consistent**: they poll until the state
matches or `timeout` (default 15_000 ms) elapses. Options object as last arg:

```ts
await expect(inbox).toHaveEmail({ subject: /welcome/i }, { timeout: 30_000 });
```

### Negation

```ts
await expect(inbox).not.toHaveEmail({ subject: /error/i });
```

Negated eventually-consistent matchers wait a grace window (default 5_000 ms)
and pass if the state never matched.

## Soft assertions

```ts
await expect.soft(screen.getByRole('status')).toHaveText('Saved');
await agent.assert('the toast confirms the invite', { soft: true });
```

Failures are recorded, the test continues, and the test is marked failed at
the end.

## Partial matching

All `match` objects are deep-partial: only specified keys are compared.
Values may be literals, regexps, or predicate functions:

```ts
await expect(hook).toHaveReceived({
  payload: { name: 'Ada', role: /engineer/i },
});
```
