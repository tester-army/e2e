# 02 - Core Test API

The canonical `sdk-0.1` declarations are
[`api/e2e.d.ts`](./api/e2e.d.ts). This document defines their behavior.

## Registration

`test()` registers a test synchronously when its module is evaluated:

```ts
import { test } from 'e2e';

test('user can sign up', async ({ app, agent }) => {
  await app.open();
  await agent.act('sign up as a new user');
  await agent.assert('the dashboard is visible');
});
```

Exports are ignored. A file MAY export a returned `TestCase` for ordinary
TypeScript composition, but doing so does not affect discovery. The collection
algorithm, stable IDs, duplicate rules, and option inheritance are specified in
[11-lifecycle.md](./11-lifecycle.md).

`test.skip` and `test.only` are declaration shortcuts. `test.only` is local
authoring behavior and is a configuration error in CI. `test.setup` requires a
static `sessions` list:

```ts
test.setup('authenticate', { sessions: ['member'] }, async fixtures => {
  await fixtures.app.open();
  const member = credentials.user('member');
  await fixtures.agent.act('sign in', {
    user: member.username,
    password: member.password,
  });
  await fixtures.session.save('member');
});
```

## Fixtures

The four universal test fixtures are `agent`, `app`, `screen`, and `platform`.
Their names are frozen for `sdk-0.1`. The setup-only `session` fixture can save
declared outputs. Ordinary tests restore only through the static `session` test
option. `web` is the capability fixture required by `web-0.1`. Driver
packages MAY augment the `TestFixtures` interface with one fixture per
platform family.

Fixtures are lazy. Accessing a fixture acquires it in the active attempt scope.
Destructuring a fixture in the callback parameter therefore acquires it before
the first statement in the body. Acquiring `agent` without model configuration
fails with `MODEL_UNAVAILABLE`; the runner does not claim whole-suite static
analysis of arbitrary TypeScript.

Capability use is explicit in portable suites:

```ts
test(
  'feature flags can be overridden',
  { requires: ['web'] },
  async ({ web }) => {
    await web.goto('/flags');
  },
);
```

The runner filters a target that lacks a declared capability before execution.
Accessing an undeclared unavailable capability is a configuration error. A
capability ID is distinct from a platform ID: an Electron target can provide
`web` without having platform `web`.

Resources are imports, not fixtures. Custom suite fixtures and `test.extend`
are post-v0.

## Agent execution boundary

Test code drives execution. Every `agent.*` call is a separate invocation with
a fresh observation, an explicit deadline, a model-call budget, and no shared
model transcript. The bounded ledger supplies prior-step context as described
in [10-determinism.md](./10-determinism.md).

The runner owns tool authorization, budget accounting, error assignment, and
reporting. Model output is untrusted input and cannot directly invoke a driver.
The runner validates every proposed tool call against the method's allowed
tools and the security policy in [14-security.md](./14-security.md).

| Method | Accepted model response | Permitted model tools |
|---|---|---|
| `act` | `agent-tool-1` sequence | tap, plain/secret type, select, scroll, press, allowed navigation, observe, conclude |
| `waitFor`, `assert` | `agent-judgment-1` response | none |
| `extract` | user-supplied Standard Schema output | none |

Any other response kind or tool is `POLICY_DENIED` before driver dispatch.

## `agent.act`

`agent.act` plans and executes a multi-action flow. `maxSteps` counts committed
driver actions. `maxModelCalls` counts every model request, including schema
repair. Observations do not consume action steps but do consume model calls and
the test timeout.

The flow is dispatched through the step-executor socket (chapter 16): the
runner owns observation, action dispatch, budgets, and recording, and the
configured executor (the `agent` config value, defaulting to the built-in AI SDK
tool-loop agent) owns only the thinking. The step concludes with a ternary
verdict — `passed`, `failed`, or `blocked` — where `blocked` carries a
blockable error code naming a closed category (credentials, environment,
seed_data, test_setup, automation) and classifies as
configuration/infrastructure rather than test failure. A `Secret` in `params`
reaches the executor only as `{ kind: 'secret', name, purpose }`; the fill
runs through the authorized `typeSecret` action, so plaintext never enters a
prompt. Sign-in is an ordinary `act` flow with `Secret` params; setup
sessions (11-lifecycle.md) provide the authentication fast path. With a
custom executor configured, `agent.assert` also dispatches
through the socket as an `assert`-kind step (default failure code
`ASSERTION_FAILED`); the built-in path keeps the single-judgment tier below.
Current release: structured output (`options.schema`) and `vision`
are not implemented for `act` and reject with `UNSUPPORTED_CAPABILITY`; the
action vocabulary is `tap`, `type`, `typeSecret`, `press`, `select`,
`scroll`, allowed `navigate`, `observe`, and `conclude`.

Parameters are immutable structured values. Plain values are disclosed to the
model. A `Secret` is represented to the model only by its name and purpose; its
value is resolved immediately before an authorized sensitive input operation.
Instructions/conditions/assertions are 1 through 8 KiB UTF-8 after NFC.
Canonical non-secret parameters are capped at 64 KiB and 32 levels of nesting.

When a Standard Schema v1 schema is supplied, the successful result contains a
required, inferred `data` field. The runner validates proposed output with the
schema's async-capable `~standard.validate`. Invalid output may be returned to
the model for repair while budget remains. Exhaustion rejects with
`MODEL_OUTPUT_INVALID`; an unhandled schema exception is an internal runner
error.

An invocation succeeds only after the agent explicitly concludes and all
requested schema output validates. Budget exhaustion never becomes a guessed
success.

## `agent.waitFor`

`agent.waitFor` is an assisted polling operation: it succeeds on the first
true judgment. `intervalMs`, default 3,000 ms,
is the shortest time between two judgments, not a pause added after each one:
it is a rate limit on model calls, and a runner MUST NOT make the caller wait
it out after a judgment that already took longer. A judgment reads the
observation, so while the observation is unchanged the answer cannot change; a
runner MAY therefore keep observing — driver-only work — and spend the next
judgment when the page changes rather than when the clock says so. A call that
sends pixels judges on the interval alone, because an animation the tree cannot
see is still a change. The interval is an integer from 100 through 60,000 ms.

Every polling method is bounded by both its timeout and the resolved
`maxModelCalls` limit.

## `agent.extract`

`agent.extract` takes one fresh observation, asks for structured output, and
validates it with Standard Schema v1. It performs no app actions. Validation
repair is allowed while `maxModelCalls` and timeout remain. The resolved value,
not an `AgentResult`, is returned.

## `agent.assert`

`agent.assert` performs one fresh observation and one model judgment. Its
timeout limits that operation; it does not poll. A false judgment rejects with
`ASSERTION_FAILED` and includes the runner-sanitized explanation and evidence.
Use `agent.waitFor` for eventually true natural-language conditions.

## Vision

Every model-backed agent method accepts `vision`, default `false`, with the
project-wide default in `agent.vision`. A per-call value always wins. It MUST be
one of four modes, which select what evidence the model is given:

- `false` — the semantic tree.
- `true` — the tree and a masked screenshot of the current observation, on every
  call.
- `"fallback"` — the tree first, escalating to add a screenshot once, and only
  after the tree turned out not to describe the target.
- `"only"` — the screenshot, and not the tree.

```ts
agent.assert('the chart trends upward', { vision: true });
agent.assert('the search form is not covered by an overlay', { vision: 'only' });
```

`"only"` exists because a tree sent alongside pixels is a cheaper path to an
answer than looking at them, and a model will take it: asked whether a form is
covered, it can read from the tree that the form is present, enabled, and named,
and answer that it is not, while the pixels show the overlay. A mode that means
"judge what the page presents" therefore removes the tree from the request rather
than asking the model to disregard it. It costs fewer input tokens than `true`,
not more.

Pixel evidence is bounded by the captured viewport (14-security.md), while the
tree describes the document. A condition that `"only"` can answer is therefore a
condition about what is on screen, and a caller that needs to judge content
further down MUST bring it into view first.

Under `"only"` the runner MUST still capture the observation, because it
reports against it; it MUST NOT include the tree serialization in
the model request, and the step MUST record that the tree was withheld
(13-reporting.md).

In every mode that sends the tree as well, pixel evidence degrades rather than
failing the call: when it is withheld the tree is still sent and the step records
why. `"only"` has nothing to degrade to, so unavailable pixel evidence MUST fail
the call with `POLICY_DENIED` instead of answering from the tree the caller
excluded.

`"fallback"` requires a signal that the tree was insufficient, and a judgment
never produces one: it always answers from the tree. Under `"fallback"`,
`assert`, `waitFor`, and `extract` therefore stay tree-only — the mode behaves
like `false` — and need `vision: true` or `"only"` to be shown pixels.

The screenshot and the tree MUST describe the same observation revision. The
reported image dimensions MUST be the true dimensions of the image bytes, and
the image MUST record its scale relative to CSS pixels.

Every mode that can send pixels requires a model that accepts image input. A model that does not fails
the call with `MODEL_PROVIDER_FAILED`. Vision calls use `agent.visionModel` when
one is configured and `agent.model` otherwise (05-config.md). Pixel policy is
defined in [14-security.md](./14-security.md).

Vision is also the only tier that may send pixel evidence *to* the model.
`assert.screenshot` is unrelated: it controls failure evidence attached to the
report after the judgment.

## Errors

`AgentError.code` is assigned by runner logic, never accepted from model text.
The closed code set is declared in `api/e2e.d.ts`. Error-to-result and exit-code
mapping is defined in [06-cli.md](./06-cli.md). Provider errors, policy denials,
timeouts, cancellations, and product assertions remain distinguishable.

## Option defaults

| Method | Default timeout | Model calls | Action steps |
|---|---:|---:|---:|
| `act` | 60 s | config limit | config `maxSteps` |
| `waitFor` | action timeout, at least 30 s | config limit | 0 |
| `extract` | action timeout, at least 30 s | 2 | 0 |
| `assert` | action timeout, at least 30 s | exactly 1 | 0 |

Every timeout is capped by the remaining test timeout. `assert.screenshot`
defaults to true unless pixel
evidence is security-tainted. `vision` defaults to `agent.vision`, itself
`false`, and does not change any budget in the table above. Per-call budgets
MUST be positive integers and cannot exceed config or hard security limits.

The closed model response grammars are
[`schema/agent-judgment-v1.schema.json`](./schema/agent-judgment-v1.schema.json)
and [`schema/agent-tool-v1.schema.json`](./schema/agent-tool-v1.schema.json).
Unknown or method-incompatible responses are policy errors.

## Steps

The exact step-producing calls and report fields are defined in
[13-reporting.md](./13-reporting.md). Internal model turns are events nested
inside one public API step; they are not top-level test steps.

## Hooks and groups

`beforeEach` and `afterEach` receive test fixtures. `beforeAll` and `afterAll`
receive only `SuiteFixtures`, currently `platform`, so suite hooks cannot leak
driver state into logically fresh test attempts.

Groups nest and inherit options. `serial: true` creates one ordered retry unit
with shared app state and ledger. Complete ordering, failure, teardown, session,
and retry rules are specified in 11-lifecycle.md.
