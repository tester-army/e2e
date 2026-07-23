# 03 — Assertions

Two assertion surfaces, deliberately split:

- **`expect()`** — deterministic: UI state via `screen` locators
  (cross-platform), web state via `web`, and plain values.
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

`expect(web)` covers web-level state: `toHaveURL(url)`, `toHaveTitle(title)`
(web targets only).

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
}): Promise<void>;
```

Semantics:

- The agent inspects the current screen (web page or native screen) and
  judges the assertion true/false.
- Failure rejects with `AgentError` (`code: 'ASSERTION_FAILED'`) containing
  the agent's reasoning and a screenshot. The failure message must be
  human-readable, e.g.:

```
agent.assert: "the dashboard is visible" — FAILED
Agent saw: a login form with an error banner "Invalid verification code".
Screenshot: artifacts/signup/assert-1.png
```

- `agent.assert()` is bound to the current target implicitly (no target
  argument needed).

## `expect(value)` — plain data

Values pulled out of `agent.extract()` (or any code) are plain data —
assert them with the usual value matchers (`toBe`, `toEqual`, `toContain`,
…):

```ts
const { total } = await agent.extract('the cart total as a number', {
  schema: z.object({ total: z.number() }),
});
expect(total).toBeLessThan(100);
```

Implementation note (the Vitest move): plain-value matchers may delegate to
a battle-tested engine (`@vitest/expect` — Jest's matcher API on a Chai
core) rather than reimplementing deep equality and diff formatting. The
engine is invisible: the only public style is `expect(x).toBe(…)` — never
Chai chains. Locator/resource/web matchers are e2e-owned: async, retrying,
driver-reading, evidence-attaching — no assertion library provides that.
Custom matchers (`expect.extend`) are roadmap.

## Resource matchers (with resource extensions, post-v0)

When resource extensions land (email first — see 04-resources.md), they
bring **world-state matchers**: `expect(inbox).toHaveEmail({ subject:
/welcome/i })`, `expect(hook).toHaveReceived(…)`, later
`expect(stripe).toHavePayment(…)`. The reserved semantics:

- **Eventually-consistent**: poll until the state matches or `timeout`
  (default 15_000 ms) elapses; options object as last arg.
- **Negation waits a grace window** (default 5_000 ms) and passes if the
  state never matched.
- **Match objects are deep-partial**: only specified keys compare; values
  may be literals, regexps, or predicate functions. Serializable by design
  (they appear in reports and the ledger).
- Always deterministic — world-state assertions never involve the model.
