# 10 — The Control Gradient

`e2e` is both a deterministic framework and an agentic one. Neither is a
mode; tiers interleave freely in the same test, and choosing per step is
the core authoring decision. Four tiers, from most model freedom to none:

| Tier | Example | Model's role |
|---|---|---|
| Planning | `agent.act('buy the pro plan')` | plans + executes multi-step flow |
| Instant actions | `agent.tap('the login button')` | **locate only** — action is deterministic, location cached |
| `screen` | `screen.getByRole('button', { name: 'Buy' }).tap()` | none — zero AI, ever |

All three tiers are cross-platform.

| Concept | Planning | Instant | Deterministic |
|---|---|---|---|
| navigate | `agent.act('go to pricing')` | — | `app.open('/pricing')` |
| interact | `agent.act('buy the pro plan')` | `agent.tap('the Buy button')` | `screen.getByRole('button', { name: 'Buy' }).tap()` |
| assert UI | `agent.assert('dashboard is visible')` | `agent.waitFor('results loaded')` | `expect(screen.getByText('Dashboard')).toBeVisible()` |
| assert world | — | — | `expect(inbox).toHaveEmail(…)` — always deterministic |
| extract | `agent.extract('cart total', { schema })` | — | `screen.getByTestId('total').textContent()` |
| login | `agent.login(credentials.user('admin'))` | `agent.type('password field', credential)` | scripted fill via `screen` |
| evidence | auto-screenshots per step | — | `app.screenshot('label')` |

The rule of thumb: `act()` when you know the goal, instant actions when you
know the steps, `screen` when you know the elements. Mixing within one test
is the expected style, not a smell:

```ts
export default test('invite teammate', async ({ app, agent }) => {
  const inbox = email.inbox('teammate');

  await app.open('/team');                                       // deterministic
  await agent.act('invite a teammate using this email', {        // agentic
    email: inbox.address,
  });
  await expect(inbox).toHaveEmail({ subject: /invitation/i });   // deterministic
  await agent.assert('the pending invite is listed');            // agentic
});
```

## The SDK is the canonical model

There is no separate "blocks" API to stay compatible with. The e2e SDK is
the source of truth for what a test *is*; TesterArmy Cloud is built on top
of it — it executes SDK tests and renders their steps. If a visual/hosted
authoring layer exists, it generates and edits SDK code, not a parallel
format.

The step/report model (below) is what makes this work: any SDK test
decomposes into a timeline of named steps with status, duration, and
evidence — which is all a dashboard needs to render, no dedicated DSL
required.

## Steps — derived, never declared

Every `agent.*` call, `screen`/`web` action, resource `expect()`, and
`app.*` call is a **step**: status, duration, evidence, one line in the
report and the Cloud timeline. Labels are derived from the call itself:

```
✓ app.open('/')
✓ act "sign up as a new user"                    2 model steps · 4.1s
✓ assert "the dashboard is visible"              screenshot
```

There is deliberately no `step()` wrapper API. It would be the only
primitive whose entire effect is presentation, and it solves Playwright's
problem (`click('#btn-3')` needs narration), not ours — natural-language
calls self-document, and `screen` queries read as well as they run. If
real suites show timeline noise around long deterministic sequences, a
closure-less section marker is the roadmap candidate — not a wrapper.

## Evidence screenshots

`app.screenshot(label?)` captures **evidence for the report** on any
platform. It is not agent observation — the agent observes through the
driver's semantic tree + its own screenshots automatically. Returns the
artifact path; appears as its own step in the report timeline.

## Execution model: code drives, agents are bounded

There is **no outer agentic loop**. The test function is plain TypeScript
executing top-to-bottom; each `agent.act()` / `agent.assert()` / instant
action is a separate, bounded sub-agent invocation that starts, works
against a step budget, concludes, and is torn down.

```ts
await agent.act('login to the app');
await agent.act('complete the onboarding, input ycombinator.com as the page to test');
await agent.assert('the example test has been generated');
```

Three isolated agent runs — but step 2 must know the login already
happened. That is solved by context engineering, not by sharing
transcripts.

### The step ledger

The runner maintains a compact, append-only **ledger** for the test. Every
step — agentic *and* deterministic — writes an entry:

```
1. [act]    "login to the app" — PASSED
   handoff: logged in as admin@acme.test via email/password; landed on /dashboard
2. [screen] getByRole('link', { name: 'Settings' }).tap() — PASSED
3. [act]    "complete the onboarding, …" — RUNNING
```

- Each agent invocation receives: the ledger (prior steps as one-line
  summaries + handoff evidence), ambient context (below), its own
  instruction + params, and a **fresh observation** of the current screen.
- On conclusion, the agent's full transcript is **discarded**; only a
  bounded handoff summary (≤ ~700 chars: what was done, what the screen
  shows now, key values like the email used) survives into the ledger.
  Context cost stays flat no matter how long the test is.
- **Deterministic steps write ledger entries too** (`app.open`, `screen`
  actions, `expect` results, `session` restores) — the next agent call
  knows what the *code* did in between, not just what previous agents did.
- Secrets never appear in ledger entries (same redaction rules as traces).

### Passing data between steps

Implicit continuity comes from the ledger; **values** move explicitly
through code — the test function is the state:

```ts
const { testUrl } = await agent.extract('the generated test URL', {
  schema: z.object({ testUrl: z.string() }),
});

await agent.act('open the generated test and run it', { url: testUrl });
```

Explicit beats implicit: params are verbatim, typed, and visible in the
test file. The ledger is for situational awareness ("login already
happened"), never for smuggling data.

### Ambient context

Background knowledge that applies to every agent invocation in the run —
quirks the agent shouldn't rediscover per step:

```ts
// e2e.config.ts
agent: {
  context: 'Dismiss the cookie banner if it appears. The app is a test-generation tool; "tests" refers to generated E2E tests, not this suite.',
}
```

Also settable per test via `test('…', { agentContext: '…' }, fn)`.

## Secrets never enter the model

Hard rule:

- `Credential` values are filled **host-side by reference**. The agent
  requests "fill the password for credential `admin`"; the runner injects the
  value into the field. Raw secrets never appear in model context, prompts,
  steps, traces, or artifacts.
- `agent.login(credential)` pins that credential: the agent cannot substitute
  a different one mid-step.
- Recorded traces and reports are redacted against sensitive-value patterns.

## Agent caching (agentic once, deterministic after)

Two caches, matching the two tiers:

- **Locate cache** (instant actions): successful locations are cached by
  target description **as `screen`-shaped queries** (e.g.
  `agent.tap('the login button')` caches as
  `getByRole('button', { name: 'Login' })`) — human-readable in diffs,
  validated on replay, AI fallback on mismatch. Repeat runs skip the model
  entirely: an instant action becomes a `screen` call.
- **Path cache** (planning): successful `agent.act()` runs record a
  sanitized action trace, keyed by test + instruction. On later runs the
  trace is replayed as **guidance** — the agent re-observes before each
  action and falls back to full reasoning when the UI changed. A failed
  cached plan is cleared, never patched mid-flow (a fallback plan from a
  mutated page state isn't valid from the initial state).

Effect: first run is exploratory; repeat runs approach deterministic speed
and cost without the brittleness of blind replay. Cache is bypassed
automatically on test retries (a retry means the cached path is suspect).

Recorded selectors follow Testing Library's **query priority**: role >
label > placeholder > text > displayValue > testId (last resort). The agent
perceives through the accessibility tree — it *is* the user Testing Library
says tests should resemble — so cached paths are resilient for the same
reason well-written queries are, and the cache is human-readable in diffs
(role/name-based steps, not brittle CSS paths).

```ts
// e2e.config.ts
agent: {
  cache: true,          // default: true
}
```

```bash
npx e2e run --no-agent-cache   # force fresh reasoning
```

Local: traces stored in `.e2e/cache`. Cloud: shared across the team + CI,
with flake-aware invalidation.

## Budgets and forced conclusions

Agent steps never spin forever. Each `agent.act()`/`agent.assert()` has:

- an action budget (`maxSteps`, default 25) with a wind-down warning before
  the cap, after which the step is forced to conclude with a typed error
- repetition detection (same action / unchanged observation loops abort
  early)
- observation-only actions don't count against the budget

## Typed error codes

`AgentError.code` separates *environment/setup* failures from *product*
failures — machine-actionable triage, distinct exit behavior, docs links in
CLI output:

```ts
type AgentErrorCode =
  // setup — your config, not your app
  | 'AUTH_CREDENTIAL_UNAVAILABLE'
  | 'AUTH_CREDENTIAL_INVALID'
  | 'APP_UNREACHABLE'
  // runtime — the agent could not conclude
  | 'STEP_BUDGET_EXHAUSTED'
  | 'STEP_TIMEOUT'
  | 'STEP_NO_CONCLUSION'
  // product — the app is broken (default for assertion failures)
  | 'ASSERTION_FAILED';

class AgentError extends Error {
  code: AgentErrorCode;
  steps: AgentStep[];
  /** The agent's own explanation of what went wrong. */
  explanation: string;
  screenshot?: string;
}
```

Setup errors are reported as *infrastructure* (CLI exit code 2/3), never as
test failures — a missing credential must not look like a product bug.
