# 01 - Design Principles

## Thesis

e2e is a TypeScript-native testing framework where code drives execution and
an agent is a bounded fixture. The same test can mix planning, model-assisted
location, and deterministic semantic automation without switching runners.

v0 proves that model on web. Future iOS and Android profiles must satisfy the
same portable contracts before the cross-platform execution claim is complete.

## Principles

### Small first example

The first useful test needs `test`, `agent.act`, and `agent.assert`. Advanced
control is progressive disclosure, not mandatory ceremony.

### One canonical contract

The root import is `e2e`; backend authoring is `e2e/backend`. Canonical public
types live under `spec/api`, wire formats under `spec/schema`, and behavioral
requirements in this specification. Examples never define behavior by accident.

### Control is per step

Planning and deterministic locators interleave in one test.
Use planning when the goal is known
and locators when the semantic element is known.

### Code drives, agents are bounded

There is no outer autonomous loop. Test code determines order and data flow.
Each agent call has explicit tools, time, model-call, action, observation, and
security bounds. Values move through TypeScript; bounded situational context
moves through the ledger.

### The standard owns semantics

Backends implement immediate queries, reads, actionability, input dispatch,
observation, state, and artifacts. The runner owns waiting, strictness, retries,
lifecycle, policy, caching, and reporting. Backend defaults cannot change a
portable test's observable semantics.

### Platforms and capabilities differ

Targets identify execution environments. Platforms describe the environment;
capabilities describe available family-specific APIs. The portable core stays
small, while versioned backend profiles and namespaced capability fixtures allow
new environments without changing test primitives.

### Local-first means accountless

The runner, results, and artifacts work locally and in CI without an e2e
account or hosted service. Deterministic suites can be offline after dependency
installation. Agent suites are offline only with an explicit local no-egress
model adapter.

### Safety is runtime behavior

Prompt injection, origin confinement, credential purpose, production opt-in,
redaction, cancellation, path containment, and untrusted-CI defaults are
normative and conformance-tested. Security is not a documentation disclaimer or
model instruction.

### Machine-legible by default

Stable IDs, typed errors, versioned JSON reports, strict session formats,
and derived source-linked steps serve humans, CI, coding agents, and future
hosted systems from one execution model.

### Resources are managed capabilities

Credentials and future email/webhook/file/phone resources have explicit
ownership, cleanup, secret, and report semantics. Extension packages add
resources; the universal fixture object does not grow with integrations.

### Migration claims are enumerated

Familiar Playwright, Testing Library, and Maestro vocabulary reduces adoption
cost. The migration table documents supported, deferred, and rejected behavior.
It is not described as full parity when exclusions exist.

## Non-goals

- YAML or JSON test DSLs.
- An autonomous outer testing agent.
- A homegrown browser/device automation engine.
- Raw backend objects in public tests.
- Unit or component testing.
- Silent self-healing after an action may have committed.
- Deterministic claims for model judgment.
- Hosted-service requirements in the core.
- Mobile execution before dedicated profiles and conformance suites exist.

## API rules

- One required primary value plus trailing options where practical. Callbacks
  and coordinate pairs are explicit exceptions.
- Public values use boring domain names: `test`, `screen`, `app`, `web`,
  `agent`, `session`, `credentials`.
- Test files end in `.e2e.ts`.
- New universal fixtures require a specification major change.
- New wire fields require schema changes; ad-hoc report payloads use namespaced
  extensions.
