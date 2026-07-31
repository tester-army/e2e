# 10 - Control Gradient, Ledger, and Cache

e2e has three interleavable control tiers:

| Tier | Example | Model role |
|---|---|---|
| Planning | `agent.act('buy the pro plan')` | plan, observe, and request bounded tools |
| Located action | `agent.tap('the buy button')` | select one node; action remains deterministic |
| Deterministic | `screen.getByRole('button', { name: 'Buy' }).tap()` | none |

The deterministic tier is behaviorally portable under an execution profile.
The agent tiers are structurally comparable, not guaranteed to choose the same
plan or judgment across models.

## Step model

Public API calls produce a derived timeline. Top-level steps are:

- every `agent.*` call;
- every locator action and locator assertion;
- every `screen` gesture;
- every `app.*` and `web.*` operation;
- every session save/restore;
- future resource actions/assertions.

Locator construction, locator refinement, direct locator reads, `platform`
reads, credential-handle creation, and plain value assertions are not top-level
steps. They are recorded as source events only when needed to explain a later
failure. Internal model turns and driver polls are child events of their public
step.

Every step has one source location, target, attempt, status, duration, typed
error when relevant, and zero or more artifact references. Exact wire fields
are defined in 13-reporting.md.

## Agent invocation

There is no outer agent loop. Each `agent.*` call starts with:

- the method's instruction and non-secret parameters;
- the bounded prior-step ledger;
- config and test ambient context;
- one fresh atomic observation when the method requires UI state;
- an allowlist of method-specific tools and remaining budgets.

The invocation ends on success, typed failure, timeout, cancellation, or budget
exhaustion. Its transcript is discarded after sanitized report events and one
bounded handoff are produced.

## Ledger

The ledger is attempt-scoped and append-only. Serial-group members share one
ledger; independent tests never do. Deterministic and agentic top-level steps
append structured entries containing method, sanitized label, status, and an
optional handoff.

Each handoff is at most 700 UTF-8 bytes. Before an agent invocation, the runner
serializes newest entries until the complete ledger context reaches resolved
`maxLedgerBytes`, default 8 KiB,
then drops oldest entries and prepends their count. Entries are presented in
chronological order. There is no recursive model summary, so cost is bounded
and compaction is deterministic.

Handoffs are untrusted quoted observations, never system instructions. The
agent prompt separates them structurally from policy and tools. Secrets and
raw provider/driver payloads are forbidden. Values required later in a test
must move through TypeScript variables, not the ledger.

## Ambient context

`config.agent.context` followed by test/group `agentContext` is trusted project
instruction. It is included after runner policy and cannot expand tool or origin
permissions. Context is capped by resolved `maxAgentContextBytes`, default
16 KiB; larger config is invalid.

## Budgets

Every agent operation is bounded by test timeout, operation timeout,
`maxModelCalls`, observation bytes, and any action-step limit.

- A model call includes initial planning, polling judgment, extraction, and
  schema repair.
- An action step is one driver action that may mutate UI state.
- Observation does not consume an action step but consumes bytes, time, and a
  model call when sent to the model.
- Every conforming adapter supplies token usage from the provider or a
  conservative tokenizer upper bound. Input/output totals and peak per call are
  always recorded with accounting source. An adapter unable to bound tokens
  rejects before provider submission and is not v0 conformant. Estimated cost
  is recorded when available and is required when a cost ceiling is configured.

The runner truncates or rejects observations over `maxObservationBytes` before
provider submission. It MUST NOT silently omit the active target or security
metadata. Truncation therefore MUST NOT be ordered by document position alone: a
dialog, drawer, or sheet is appended at the end of a document, which makes what
the user is looking at the first thing dropped. A runner that reports node
geometry MUST prefer content inside the viewport, with the ancestors that place it
in the tree, and spend what remains of the budget on content outside the viewport.
A runner whose driver reports no geometry cannot order by visibility and falls back
to document order. A serialized observation MAY annotate a node with its position
relative to the viewport, which is what lets a model choose between controls that
are otherwise described identically. Such an annotation is advisory context for
selection only: it is never an argument to an action, and it MUST NOT participate
in whether two observations are considered to show the same screen, because it is
viewport-relative and scrolling moves all of it.

Repeating the same proposed action against the same observation revision twice is
`STEP_NO_CONCLUSION`. Exhausted action/model budget is `STEP_BUDGET_EXHAUSTED`;
elapsed deadline is `STEP_TIMEOUT`.

## Cache goals

The cache is an optimization, never authority. A cache hit cannot weaken
query strictness, origin policy, actionability, secret policy, budgets, or
reporting. Disabling or deleting the cache cannot change a correct test's
intended semantics.

There are two entry kinds:

- **Locate:** maps one located-action call to a locator. Every located action
  qualifies — they differ in what they do with the node, not in how they find it,
  and the entry stores only the finding. A valid hit uses zero model calls.
- **Path:** stores a structured successful `agent.act` action trace as
  guidance. Replay still uses a model and fresh observations and is not called
  deterministic replay.

The normative wire format is `cache-1` in 13-reporting.md.

## Cache identity

Every key includes:

- specification and cache-schema versions;
- normalized project identity;
- test ID, target ID, platform, driver ID, driver compatibility version, and
  SPI version;
- public method and the zero-based index of this call among identical calls,
  where identical means same method, instruction digest, and parameter digest;
- SHA-256 digest of the normalized instruction;
- canonical non-secret parameter and schema digest;
- app identity and starting route fingerprint;
- agent-policy version.

Secret values never enter a key or digest. A secret contributes only its stable
credential/field name and purpose. Instruction normalization converts CRLF/CR
to LF, applies Unicode NFC, and trims leading/trailing Unicode whitespace
without altering interior whitespace. Every canonical digest uses RFC 8785 JSON
Canonicalization Scheme followed by SHA-256 over UTF-8. Regular expressions
first normalize to `{ source, flags }` with flags sorted and de-duplicated.
Flags use canonical `d,g,i,m,s,u,v,y` order and `u`/`v` are mutually exclusive.
Regexp source is capped at 1,024 UTF-8 bytes. Cache regexp evaluation runs in an
interruptible worker under the original operation deadline; timeout invalidates
the entry rather than blocking the runner.

The call index counts only repeats of the same call, and only calls that were
actually keyed. It must not be a running total over every agent call in the
test: under that reading a conditional step, such as a consent dialog that
appears on some sessions and not others, renumbers every entry recorded after it
and a suite against a real application can never warm up. A non-cacheable call,
a call that opted out with `cache: false`, and a call under a disabled cache all
take no number.

Project identity is SHA-256 of the resolved `projectId`. App identity for a
cache key is SHA-256/JCS of the declared environment alone. It deliberately
excludes the base origin and base path: a preview deployment, a staging host, and
`localhost` on another port serve the same app, and keying on where it runs
cold-starts every entry on every deploy. Session state is bound by the stricter
identity that does include origin and base path (11-lifecycle.md), because
restoring cookies across origins is not the same question.

Driver identity uses manifest ID/SPI plus a compatibility version:
`major.minor`, with patch, prerelease, and build metadata dropped, because a
driver patch release cannot change what a semantic query matches. A version that
is not `major.minor[.patch]` is used unchanged. The key's explicit `cacheSchema`
value is `cache-1`.

The starting route fingerprint is SHA-256/JCS of the canonical route and the
exact `width x height @ scale` viewport. A route inside the app is its path
relative to the configured base; a page on any other origin keeps that origin,
because an identity provider's `/login` is not the app's `/login`.

Query, userinfo, and fragment are all dropped. The query is where a site keeps
what is not the place: a session marker, a campaign tag, an experiment bucket.
One production offer page was observed arriving as `?...,srcx_auction` on one run
and `?...,srcx_v4_auction` on the next, which was enough to mint a new key for a
step that had not changed. Dropping it also means a query can never carry a
secret into a key. Two places differing only by their query share a route, which
is safe for the same reason as any other route collision: a route is not a key.

Path normalization replaces every segment that identifies a record rather than a place — a UUID, a
long hex digest, a numeric id, an opaque token — with a fixed placeholder. A
checkout at `/order/<per-session hash>/form` is the same place on every run, and
hashing the raw path would give every visit its own key: nothing would ever hit
and the store would grow one dead entry per run. Two places differing only by
such a segment collapse, which is safe because a key is never a route alone.

URLs whose path carries values classified sensitive by app policy are not
cacheable. A driver that exposes no URL contributes no route. A mismatch is a
cache miss.

The fingerprint MUST NOT hash the semantic tree. Rendered content on a real
application changes continuously — prices, counts, ordering, advertising — so a
content-derived key is invalidated within hours and the cache never returns a
hit. Replay safety does not come from proving the screen is unchanged. It comes
from the recorded locator expressing the same intent as the instruction, and
from verifying the resolved node before the action runs. A flow that stays on one
route is still separated by instruction, parameters, and occurrence index.

## Locate replay

A locate entry stores one locator plus the expected role and name. It never
stores a node reference, coordinate, model prose, instruction text, or secret.

A node inside an embedded document is stored behind the chain of iframe
selectors that reaches it; neither a query nor a selector crosses a frame on its
own. The recorded identity is role and name, of which at least one is required:
an unlabelled container — a drag handle, a hover zone — is identified by its
accessible name alone, and a node with neither cannot be verified and is not
stored.

The locator is the semantic `screen` expression that re-found the node. A runner
MAY instead store the platform selector the driver reported for the node, and it
MUST prefer the semantic expression whenever that expression is recordable: an
expression says what the node is, so it survives the DOM churn that invalidates
any structural path. The selector exists for the node whose expression is not
recordable — a control the page repeats verbatim, which no derived query names —
and which otherwise could not be cached at all and paid a model locate every run.

A driver SHOULD NOT report a selector that is positional all the way to the
document root, and a runner SHOULD NOT store one. Such a path is shifted by
anything inserted above the node — a chat widget, a consent frame, a portal —
none of which has anything to do with the node. Measured against a production
page that injects one, the entry went stale between every run: the step paid its
full model locate anyway and left one dead entry behind each time, while
reporting that it had recorded something. A selector anchored on an attribute
that names an element or one of its ancestors is positional only below that
anchor; where no such anchor exists, reporting no selector costs the same locate
and states the reason.

A stored selector is a guess, never an identity. Replay resolves it, reads the
node it landed on, and requires the recorded role and name before the entry is
used, so a selector that has gone stale — the DOM moved, the path now points at
something else — costs a miss and one model locate. That is the same price as
having stored nothing, which is what makes storing it optimistically safe.

States are not stored: actionability re-checks the ones that matter before the
action runs, so recording them would only add ways to miss.

Identity comparison is case-insensitive on the name. A control that renders
"DALEJ" one run and "Dalej" the next — a text transform, a re-render, a label the
app cases by state — is the same control, and comparing case makes each run
reject the previous run's entry and rewrite it, so the step never replays.

On replay, the runner resolves once. Exactly one compatible node is required.
Zero, multiple, stale, or incompatible results are a miss and permit one fresh
model locate. The eventual action still uses normal actionability and policy.
A successful fresh locate atomically replaces the entry in read-write mode.

Only a content-addressed target is recordable. When the instruction identifies a
node by where it sits rather than by what it says — "the first result", "the last
row" — every locator the runner can derive still matches on content, so replay
resolves whichever item now carries that content rather than whichever now
occupies that position. That is a wrong answer rather than a miss, which the
cache must never produce, so such a call reports a miss that was not recorded and
pays for one model locate on every run.

The runner learns how a target was identified from the `positional` field of
`agent-locate-1`. A runner MUST treat an absent field as positional and MUST NOT
default it to false. It MUST also declare the field as required in the
structured-output schema it requests the locate under: that schema is closed, so
a field it does not declare is one a strict provider strips from the response,
and asking for it in the prompt alone leaves every locate unrecordable and the
cache permanently cold. Tolerating absence is a backstop for a provider that does
not enforce schemas, not the expected path. Absence is silence, not an assertion,
and the two failure modes are not worth trading: declining to record costs one
model locate per run, while recording a positional target wrongly costs a wrong
action.

A locator's shape is not a substitute for the report. A derived locator may carry
an index, but it carries one because the *page* repeats a control, not because the
*instruction* named a position — "the Reserve now button for Offer B" needs an
index and is still content-addressed. So the two questions are independent and the
model's report is the only answer to this one.

An index-bearing locator MUST NOT be recorded, whatever the instruction was. The
index is measured against the match set of the run that resolved it, so replaying
it finds whichever node now occupies that position. Nothing catches the
difference: an index is only ever needed when the matches are semantically
identical, so the recorded role and name match every one of them and the identity
check passes on the wrong node. A runner MAY instead record the platform selector
for that node, which is anchored on an attribute that names the element and so
still addresses the same control after a reorder.

## Path guidance

A path entry is a sequence of normalized derivatives of successful
`agent-tool-1` calls, restricted by the closed action-specific union in
`cache-1`. Cache actions intentionally replace revision-bound node refs with
semantic locators and omit the protocol envelope. They contain semantic targets
and no values: a recorded fill names its target only, because the agent re-reads
values from the invocation's parameters on every run and a path entry is stored
where a project may commit it.

Guidance is advisory. Before each proposed action the agent receives a fresh
observation and decides whether the next recorded action is still applicable, so
declining it is an ordinary outcome: the runner discards the remaining guidance
and continues full reasoning in the same invocation. Guidance MUST NOT be able
to turn an otherwise passing invocation into a failing one.

A runner that instead dispatches recorded actions without asking the model each
time is replaying rather than being guided. Such a runner MUST NOT restart or
replay from the beginning once a mutating action has committed, and rejects
divergence past that point with `CACHE_REPLAY_DIVERGED`, because re-applying a
committed mutation is not a cache hit. A runner that re-decides every action, as
described above, cannot reach that state and never raises the code. A test-level
retry starts from clean state and bypasses all agent caches.

Only a completely successful non-retry invocation writes path guidance. Failed,
timed-out, interrupted, policy-denied, or flaky attempts never update it.

## Storage and concurrency

Cache files live under `.e2e/cache/`, one entry per key, named for the key's
SHA-256/JCS digest. An entry does not repeat its own key: a runner only ever
opens the digest of the key it just computed, so the file being there is what
identifies it. Readers check size and path containment, and validate the locator
shape, before use. An entry that fails is ignored and reported as
`cache-invalid`, never repaired and never interpreted as executable code.

Readers MUST validate the locator shape, because that is what gets handed to the
locator engine. They need not validate anything they do not consume: a malformed
timestamp or an unknown field cannot change what runs, and rejecting an entry
over one discards a usable locator for no gain.

Writes go to a same-directory temporary file with a unique name and are then
renamed atomically, so a crashed or concurrent writer cannot leave a torn entry
behind. No lock is required. Two writers collide on a key only when the same call
runs concurrently on the same route, and then they are writing the same locator,
so last-write-wins is the correct outcome.

Committed caches are untrusted repository input, and the locator union is the
whole of their authority. An entry is strict JSON containing no free-form
instructions, and nothing in it is ever shown to a model, so it cannot inject an
instruction, bias a judgment, or carry a secret.

What it can do is aim a locator. A semantic query addresses only what a user
could perceive; a stored platform selector does not, because it is arbitrary CSS
and the identity check on replay constrains what the resolved node must be, not
which nodes the selector may reach. A hostile entry can therefore point a cached
action at a node the observation withholds, provided that node still carries the
recorded role and name and still passes actionability. The blast radius is
bounded — the action is the one the test already called, so an entry cannot add a
step the test does not contain — but it is not nil. That is why cache review is
review of untrusted input, why CI defaults to read-only, and why untrusted PR
jobs MUST NOT publish cache changes to a trusted branch or shared store.

## Error ownership

The runner maps validated facts to the closed `AgentErrorCode` set in
`api/e2e.d.ts`. Model prose cannot select a code. Driver errors are translated
using commit/retry metadata, provider errors using adapter status, and
assertions using runner-owned judgment parsing. Exit mapping is in 06-cli.md.
