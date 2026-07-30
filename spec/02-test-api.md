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

A page that repeats a control — one reservation button per row, the same label
on each — has nodes no derived query can separate. The reference the observation
handed out can: it is bound to the element the model was shown, in the revision
it was shown in, which is a stricter identity than any locator. A runner MAY
therefore act through that reference once no derived query resolves the
selection, after re-reading it to confirm it is still the node the model chose.
A reference cannot outlive its observation, so such a target is never recorded
(10-determinism.md). A runner that also offers `vision: 'fallback'` MUST prefer
the escalation: an unaddressable selection is that feature's signal, and pixels
can tell repeated controls apart that a reference can only take on trust from a
tree-only answer.

`agent.type` replaces the target's current content and accepts plain strings or
opaque `Secret` values. It never submits the field; submission is a separate
tap/click/press step. A secret may be sent only to an authorized secure input
sink and is never included in a model request, cache key, ledger, report, or
artifact.

`agent.scroll` uses no model when `within` is absent and one locate call when it
is present. `scrollTo` and `waitFor` are assisted polling operations rather than
single-call instant actions:

- `scrollTo` alternates deterministic scrolling and fresh locate judgments
  until the node is found or the timeout/model-call budget expires. Found is not
  the same as reachable on a profile whose observation carries nodes outside the
  viewport: such a node is located on the first judgment without anything having
  scrolled, so `scrollTo` completes only once the target no longer reports
  `states.offscreen`. That tail is deterministic — the runner re-resolves the
  query the model already produced — so reaching a distant target costs no
  further model calls, and a profile whose backend scrolls as part of
  actionability never enters it.
- `waitFor` succeeds on the first true judgment. `intervalMs`, default 3,000 ms,
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
agent.tap('the red pin on the map', { vision: true });
agent.tap('the first offer card', { vision: 'fallback' });
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
hit-tests and reports against it; it MUST NOT include the tree serialization in
the model request, and the step MUST record that the tree was withheld
(13-reporting.md). Because there are then no node identifiers the model has seen,
a locate under `"only"` MUST be sent the point-only response grammar, and a
method with no coordinate equivalent MUST reject `"only"` with `POLICY_DENIED`
before its first model call rather than spending one on an unsatisfiable request.

In every mode that sends the tree as well, pixel evidence degrades rather than
failing the call: when it is withheld the tree is still sent and the step records
why. `"only"` has nothing to degrade to, so unavailable pixel evidence MUST fail
the call with `POLICY_DENIED` instead of answering from the tree the caller
excluded.

`"fallback"` requires a signal that the tree was insufficient, and a locate is
the only operation that produces one without guessing: the model reports no
match, or no derived query resolves the node it chose. A method that locates a
single target MUST escalate on exactly those outcomes, at most once per
invocation, and MUST NOT escalate after any action has been dispatched.

A judgment always produces an answer from the tree, so there is no such signal
for `assert`, `waitFor`, and `extract`; under `"fallback"` they stay tree-only.
`agent.scrollTo` also stays tree-only, because inside its polling loop a
tree-only miss is indistinguishable from "the target has not been scrolled to
yet". Those methods need `vision: true` to be shown pixels.

Because escalation runs the locate a second time, a `"fallback"` invocation's
model-call budget MUST cover both tiers.

The screenshot and the tree MUST describe the same observation revision. The
reported image dimensions MUST be the true dimensions of the image bytes, and
the image MUST record its scale relative to CSS pixels, because every
coordinate the model reads off it is relative to those dimensions.

Every mode that can send pixels requires a model that accepts image input. A model that does not fails
the call with `MODEL_PROVIDER_FAILED`. Vision calls use `agent.visionModel` when
one is configured and `agent.model` otherwise (05-config.md); visual grounding
is a materially higher bar than accepting an image, and a model may judge pixels
well while pointing at them badly. Pixel policy is defined in
[14-security.md](./14-security.md).

Vision is also the only tier that may send pixel evidence *to* the model.
`assert.screenshot` is unrelated: it controls failure evidence attached to the
report after the judgment.

### Visual pointing

Under `vision`, and only under it, a locate response may answer with a point in
the attached screenshot instead of a node id. It exists for surfaces the tree
cannot describe, such as canvas, WebGL, and custom-drawn widgets.

Whether pointing is offered is decided by the calling method, before the model
is asked. A method with no coordinate equivalent MUST be sent the node-only
response grammar and the node-only request text even when pixels are attached,
so a point can never be returned to a caller that cannot act on one.

The runner owns everything about that point:

- it is bounded to the reported image dimensions; an out-of-bounds point is
  invalid model output and spends one repair round rather than being clamped;
- it is converted to CSS pixels, rounded, and clamped once before dispatch;
- it is hit-tested against the same observation, and the innermost node found —
  role and name, or the absence of any node — is recorded on the step;
- the action itself remains predetermined by the API call. The model still
  never names an action or an error code.

Dispatch happens at the point, not at the center of the hit-tested node:
retargeting would leave the pixels the model chose, which on a canvas is the
whole surface. Only `tap` and `click` offer a point, because every other method
needs a semantic node to act on; those methods still receive the screenshot,
which is what lets the model choose a better node. A point answered to a
node-only call is invalid model output. A driver without coordinate input
cannot serve pointing at all.

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
evidence is security-tainted. `vision` defaults to `agent.vision`, itself
`false`, and does not change any budget in the table above. Per-call budgets
MUST be positive integers and cannot exceed config or hard security limits.

The closed model response grammars are
[`schema/agent-locate-v1.schema.json`](./schema/agent-locate-v1.schema.json),
[`schema/agent-judgment-v1.schema.json`](./schema/agent-judgment-v1.schema.json),
and [`schema/agent-tool-v1.schema.json`](./schema/agent-tool-v1.schema.json).
Unknown or method-incompatible responses are policy errors.

A locate response naming a node id, observation revision, or screenshot point
outside the current observation is invalid model output: the runner rejects it
before any driver dispatch and spends remaining model-call budget on one repair
round instead of failing the step outright. A point is offered only by the
vision variant of the locate grammar; a point answered to a tree-only call is
invalid output, never an accepted coordinate.

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
