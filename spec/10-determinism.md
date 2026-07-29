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
metadata. Repeating the same proposed action against the same observation
revision twice is `STEP_NO_CONCLUSION`. Exhausted action/model budget is
`STEP_BUDGET_EXHAUSTED`; elapsed deadline is `STEP_TIMEOUT`.

## Cache goals

The cache is an optimization, never authority. A cache hit cannot weaken
query strictness, origin policy, actionability, secret policy, budgets, or
reporting. Disabling or deleting the cache cannot change a correct test's
intended semantics.

There are two entry kinds:

- **Locate:** maps one located-action call to a portable locator expression.
  A valid hit uses zero model calls.
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

Project identity is SHA-256 of the resolved `projectId`. App identity is
SHA-256/JCS of effective base origin, normalized base path, and declared
environment. Driver identity uses manifest ID/SPI plus a compatibility version:
`major.minor`, with patch, prerelease, and build metadata dropped, because a
driver patch release cannot change what a semantic query matches. A version that
is not `major.minor[.patch]` is used unchanged. The key's explicit `cacheSchema`
value is `cache-1`.

The starting route fingerprint is SHA-256/JCS of the canonical URL and the exact
`width x height @ scale` viewport. The canonical URL keeps origin, normalized
path, and sorted query, and drops userinfo and fragment. Any exact registered
secret in a query is replaced by its stable secret name before hashing; URLs
containing other values classified sensitive by app policy are not cacheable. A
driver that exposes no URL contributes no route. A mismatch is a cache miss.

The fingerprint MUST NOT hash the semantic tree. Rendered content on a real
application changes continuously — prices, counts, ordering, advertising — so a
content-derived key is invalidated within hours and the cache never returns a
hit. Replay safety does not come from proving the screen is unchanged. It comes
from the recorded locator expressing the same intent as the instruction, and
from verifying the resolved node before the action runs. A flow that stays on one
route is still separated by instruction, parameters, and occurrence index.

## Locate replay

A locate entry stores a semantic `screen` locator expression and the expected
role and name. It never stores a node reference, coordinate, CSS/XPath selector,
model prose, instruction text, or secret. States are not stored: actionability
re-checks the ones that matter before the action runs, so recording them would
only add ways to miss.

On replay, the runner resolves once. Exactly one compatible node is required.
Zero, multiple, stale, or incompatible results are a miss and permit one fresh
model locate. The eventual action still uses normal actionability and policy.
A successful fresh locate atomically replaces the entry in read-write mode.

A positional target is never recorded. When the instruction identifies a node by
where it sits rather than by what it says — "the first result", "the last row" —
a stored locator is content-addressed and would keep resolving to whichever item
occupied that position when it was recorded. That is a wrong answer rather than a
miss, which the cache must never produce, so such a call reports a miss that was
not recorded and pays for one model locate on every run. The runner learns that
a target is positional from the optional `positional` field of `agent-locate-1`;
the field is a caching hint only, defaults to false, and can never change what
the runner executes.

## Path guidance

A path entry is a sequence of normalized derivatives of successful
`agent-tool-1` calls, restricted by the closed action-specific union in
`cache-1`. Cache actions intentionally replace revision-bound node refs with
semantic locators and omit the protocol envelope. They contain semantic targets and
non-secret values, with no arbitrary options. Before each proposed replay
action, the agent receives a fresh observation and decides whether the next
recorded action is still applicable.

If guidance diverges before any mutating action commits, the runner may discard
it and continue full reasoning in the same invocation. After any mutating
action commits, divergence rejects with `CACHE_REPLAY_DIVERGED`. It MUST NOT
restart or replay from the beginning inside that attempt. A test-level retry
starts from clean state and bypasses all agent caches.

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

Committed caches are repository input. They contain only strict JSON and no
free-form instructions, and the strongest thing one can express is a semantic
locator, which can address only what a user could perceive. CI defaults to
read-only; untrusted PR jobs MUST NOT publish cache changes to a trusted branch
or shared store.

## Error ownership

The runner maps validated facts to the closed `AgentErrorCode` set in
`api/e2e.d.ts`. Model prose cannot select a code. Driver errors are translated
using commit/retry metadata, provider errors using adapter status, and
assertions using runner-owned judgment parsing. Exit mapping is in 06-cli.md.
