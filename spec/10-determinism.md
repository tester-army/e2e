# 10 - Control Gradient and Ledger

e2e has two interleavable control tiers:

| Tier | Example | Model role |
|---|---|---|
| Planning | `agent.act('buy the pro plan')` | plan, observe, and request bounded tools |
| Deterministic | `screen.getByRole('button', { name: 'Buy' }).tap()` | none |

The deterministic tier is behaviorally portable under an execution profile.
The agent tier is structurally comparable, not guaranteed to choose the same
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

## The trace cache (trace-1)

The runner MAY cache, per `agent.act()` step, the ordered list of grammar
actions the step performed on its last passing run — an **action trace** —
and replay it on a later run with zero model calls. What is cached is what
the step *did*, never what a model *said*: judgments (`agent.assert`,
`agent.waitFor`, `agent.extract`) are made fresh, per run, from a fresh
observation, always.

Caching is opt-out: an unset `cache` key means `read-write` (05-config.md),
and a project or run opts out with `cache: 'off'` or the `--no-cache` flag,
which wins over the config. In CI the mode is forced from `read-write` down
to `read-only` whatever the config chose: committed caches are untrusted
input, and a CI run never publishes what it learned.

### Entries and keys

An entry (`schemaVersion: "trace-1"`) wraps one `ActionTrace`: the recorded
actions, each with a durable target descriptor (role, name, testid,
placeholder, structural selector — captured at commit time from the node the
action actually ran against), JSON-safe secret-free input, and a one-line
prose summary; plus producer provenance and the page path the step began on.
Secret plaintext MUST NOT appear anywhere in an entry — a secret fill is
recorded by its stable name only, and every recorded string passes the run's
secret redactor first. A mutation the grammar cannot reproduce (a mutating
project tool) is recorded as a **gap marker**, so replay can never silently
skip a state change.

The key names the exact context the trace was recorded in: project, test,
target/driver/app identity, step kind, the digests of the normalized
instruction and the projected params, a per-signature occurrence index, and
the replay policy version. Executor identity is provenance **on the entry**,
never part of the key. Ambient agent context (`agent.context`, per-test
context) is deliberately not part of the key either: a trace records a flow
that verifiably worked, the deterministic assertions after each step own
semantic drift, and an implicated entry is evicted — keying on prose would
cold-start the cache on every wording tweak while proving nothing about the
flow.

A trace with no start anchor — no recorded start path (a session without a
page URL) and no opening navigate — is never written: it could only ever miss
with `wrong-context`, and an unreplayable entry is pure store traffic. Every reason an entry cannot be used — absent,
malformed, oversized, truncated, recorded on a different page — is a miss
that dispatches the executor, never an error and never a step failure.

### The adaptive flow

On a hit, the runner replays the recorded actions through the same action
grammar the executor uses — deadline, action budget, origin policy, secret
authorization, and recording all apply identically. Each targeted action
re-finds its node from the recorded descriptor against a fresh observation;
exactly one node must match or the replay diverges. A full successful replay
self-finalizes the step as passed. Any divergence — a gap, a moved or
ambiguous target, a rejected action — hands the step to the executor
mid-step with a `replayedPrefix` notice (16-executors.md); the executor
continues from live state. Runtime hard stops (budget, timeout, cancel) are
never divergence: they propagate as the step's own accounting.

Writes are staged, then settled at attempt end. A step's own passing verdict
is not what proves the flow reached the right state — the deterministic
assertion after it is. A staged trace is **confirmed** (written) when the
attempt passed or any later step passed after it; on a failed attempt the
staged trace of the last passed step is implicated instead, and its entry is
**evicted**, so a cached flow that led to a failure re-records on the next
pass rather than replaying a poisoned state forever. A step that settles
non-passed after consuming a cached replay evicts that entry directly for the
same reason. Interruption and cancellation implicate nothing: an interrupted
attempt neither writes nor evicts. Confirmed rewrites are unconditional —
including after a replay, which is how stale descriptors self-heal — and only
passing steps ever stage. The store is disposable: flushing it can slow the
next run, never change a verdict.

### Storage and concurrency

The default store keeps one JSON file per key digest under `.e2e/cache/`,
written via a temporary file and an atomic rename; entries over 1 MiB are
invalid on read and refused on write. A project may replace the store with
any `TraceCacheStore` implementation (a shared remote cache); the read/write
contract and the fail-to-miss rule travel with the interface, not the
backend.

Runs are comparable through the report either way: every agent step records
how the cache participated (`self-finalized`, `agent-concluded`, or `missed`,
with a reason token) alongside its metrics.

## Error ownership

The runner maps validated facts to the closed `AgentErrorCode` set in
`api/e2e.d.ts`. Model prose cannot select a code. Driver errors are translated
using commit/retry metadata, provider errors using adapter status, and
assertions using runner-owned judgment parsing. Exit mapping is in 06-cli.md.
