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

## No caching

v0 performs no caching of any kind. Every agent decision — every plan,
judgment, and extraction — is made fresh, per run, from a fresh observation.
Two runs are therefore comparable only through the report: the report records
what each run observed and decided, and there is no replay mechanism that
could reproduce one run's decisions inside another.

## Error ownership

The runner maps validated facts to the closed `AgentErrorCode` set in
`api/e2e.d.ts`. Model prose cannot select a code. Driver errors are translated
using commit/retry metadata, provider errors using adapter status, and
assertions using runner-owned judgment parsing. Exit mapping is in 06-cli.md.
