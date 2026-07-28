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
  await fixtures.agent.login(credentials.user('member'));
  await fixtures.session.save('member');
});
```

## Fixtures

The four universal test fixtures are `agent`, `app`, `screen`, and `platform`.
Their names are frozen for `sdk-0.1`. The setup-only `session` fixture can save
declared outputs. Ordinary tests restore only through the static `session` test
option. `web` is the capability fixture required by `web-0.1`; `device` is
reserved for future mobile profiles. Driver packages MAY augment the
`TestFixtures` interface with one fixture per platform family.

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
| `act` | `agent-tool-1` sequence | tap, plain/secret type, scroll, press, long-press, allowed navigation, observe, conclude |
| `login` | `agent-tool-1` sequence | tap, pinned username/password type, scroll, press, allowed navigation, observe, conclude |
| `tap`, `click`, `type`, `longPress`, `press`, `select`, `hover`, `check`, `uncheck`, `upload` | one `agent-locate-1` response | none; runner performs the predetermined action |
| `dragTo` | two `agent-locate-1` responses (source, then destination) | none; runner performs the predetermined drag |
| `scroll` without `within` | no model response | none |
| `scroll` with `within` | one `agent-locate-1` response | none; runner scrolls deterministically |
| `scrollTo` | repeated bounded `agent-locate-1` responses | none; runner scrolls deterministically |
| `waitFor`, `assert` | `agent-judgment-1` response | none |
| `extract` | user-supplied Standard Schema output | none |

Any other response kind or tool is `POLICY_DENIED` before driver dispatch.

`upload` file paths and `press` keys come from trusted test code, resolve on
the runner host (paths from the project root), and never appear in any model
prompt: the model only ever selects the target node.

## `agent.act`

`agent.act` plans and executes a multi-action flow. `maxSteps` counts committed
driver actions. `maxModelCalls` counts every model request, including schema
repair. Observations do not consume action steps but do consume model calls and
the test timeout.

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

## Instant actions

`tap`, `click`, `type`, and `longPress` use the model only to select exactly one
node from one fresh observation. On a valid locate-cache hit they use zero model
calls. On a miss they use exactly one model call and then execute exactly one
driver action. They never replan, navigate, or choose an alternate action.

The model returns a semantic node reference plus a runner-generated query. The
runner validates that both identify the same unique node before acting. Zero
matches rejects with `LOCATOR_NOT_FOUND`; multiple matches rejects with
`LOCATOR_AMBIGUOUS`; actionability failure rejects with `ACTION_FAILED`.

`agent.type` replaces the target's current content and accepts plain strings or
opaque `Secret` values. It never submits the field; submission is a separate
tap/click/press step. A secret may be sent only to an authorized secure input
sink and is never included in a model request, cache key, ledger, report, or
artifact.

`agent.scroll` uses no model when `within` is absent and one locate call when it
is present. `scrollTo` and `waitFor` are assisted polling operations rather than
single-call instant actions:

- `scrollTo` alternates deterministic scrolling and fresh locate judgments
  until the node is found or the timeout/model-call budget expires.
- `waitFor` makes one fresh observation and judgment per `intervalMs`, default
  3,000 ms. It succeeds on the first true judgment. The interval is an integer
  from 100 through 60,000 ms.

Every polling method is bounded by both its timeout and the resolved
`maxModelCalls` limit.

Long-press `durationMs` defaults to 500 ms and must be an integer from 100
through 10,000 ms on both agent and locator surfaces.

## `agent.login`

`agent.login(credential)` is a planning invocation with one pinned credential.
The model may request username or password fills only for that credential. The
runner authorizes each destination origin and field purpose independently. A
rejected login is `AUTHENTICATION_FAILED`; missing material is
`AUTH_CREDENTIAL_UNAVAILABLE`.

The method does not implicitly open the app. Calling it before `app.open()` or
equivalent navigation fails with the test error `APP_NOT_OPEN`.
Login is never path-cached; setup sessions provide the authentication fast path.

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

## Errors

`AgentError.code` is assigned by runner logic, never accepted from model text.
The closed code set is declared in `api/e2e.d.ts`. Error-to-result and exit-code
mapping is defined in [06-cli.md](./06-cli.md). Provider errors, policy denials,
timeouts, cancellations, and product assertions remain distinguishable.

## Option defaults

| Method | Default timeout | Model calls | Action steps | Cache |
|---|---:|---:|---:|---|
| `act` | 60 s | config limit | config `maxSteps` | inherited mode |
| `login` | 60 s | config limit | config `maxSteps` | off |
| `tap/click/type/longPress/press/select/hover/check/uncheck/upload` | action timeout | up to 2 on miss (one repair) | exactly 1 | inherited mode |
| `dragTo` | action timeout | up to 4 (one repair per locate) | exactly 1 | inherited mode |
| `scroll` | action timeout | 0, or up to 2 with `within` | exactly 1 | locate only |
| `scrollTo`, `waitFor` | action timeout, at least 30 s | config limit | bounded by calls | locate only/off |
| `extract` | action timeout, at least 30 s | 2 | 0 | off |
| `assert` | action timeout, at least 30 s | exactly 1 | 0 | off |

Every timeout is capped by the remaining test timeout. `cache: false` disables
cache for that call; `cache: true` uses the resolved run mode and cannot upgrade
read-only to read-write. `assert.screenshot` defaults to true unless pixel
evidence is security-tainted. Per-call budgets MUST be positive integers and
cannot exceed config or hard security limits.

The closed model response grammars are
[`schema/agent-locate-v1.schema.json`](./schema/agent-locate-v1.schema.json),
[`schema/agent-judgment-v1.schema.json`](./schema/agent-judgment-v1.schema.json),
and [`schema/agent-tool-v1.schema.json`](./schema/agent-tool-v1.schema.json).
Unknown or method-incompatible responses are policy errors.

A locate response naming a node id or observation revision outside the current
observation is invalid model output: the runner rejects it before any driver
dispatch and spends remaining model-call budget on one repair round instead of
failing the step outright.

A locate response always carries a short `explanation`: why the selected node
matches, or, with `target: null`, why nothing in the observation does. An
explicit `target: null` is a valid response, not a policy error: the runner
raises `LOCATOR_NOT_FOUND` carrying the model's explanation (`scrollTo` keeps
scrolling and reports the last explanation on budget exhaustion). The model
never selects an error code; explanations are bounded untrusted prose.

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
