# RFC0000: e2e agentic testing standard

## Summary

e2e standardizes a TypeScript test API, runner lifecycle, web execution
semantics, driver SPI, safety policy, and machine-readable result formats for
agentic end-to-end tests.

The central constraint is simple: code drives; agents are bounded operations.
Tests can choose planning, model-assisted location, or deterministic semantic
automation per step.

v0 is local-first and web-only. Mobile remains the product direction, not a
present-tense runtime claim.

## Example

```ts
import { test, expect, credentials } from 'e2e';

test('member upgrades to Pro', { session: 'member' }, async ({ app, agent, screen }) => {
  await app.open('/settings/billing');
  await screen.getByRole('button', { name: 'Upgrade' }).tap();
  await agent.tap('the Pro plan card');
  await agent.act('complete payment with the test card');
  await expect(screen.getByRole('status')).toContainText('Pro');
});
```

## Problem

Existing choices force teams to trade among deterministic control, agentic
authoring, runner ownership, machine-readable diagnostics, and platform
portability. AI helpers bolted onto another runner cannot consistently own
budgets, lifecycle, retries, cache safety, resources, or report semantics.

Naive autonomous testing also fails in CI: it is expensive, nondeterministic,
hard to review, vulnerable to prompt injection, and prone to repeating side
effects after partial failure.

## Decisions

### One execution model

Plain TypeScript determines control flow. Each `agent.*` call starts a fresh
bounded invocation with explicit tools, observation, ledger context, deadline,
model-call budget, and policy. Transcripts are discarded; values move through
code.

### Three control tiers

| Tier | Example | Model authority |
|---|---|---|
| Planning | `agent.act('buy the pro plan')` | bounded plan and tools |
| Located action | `agent.tap('the Pro card')` | choose one node |
| Deterministic | `screen.getByRole(...).tap()` | none |

The deterministic tier has behavioral conformance. Agentic execution has
comparable inputs, policy, limits, errors, and reports, but model plans are not
claimed deterministic.

### Runner-owned semantics

The runner owns query polling, strictness, assertions, retries, sessions,
lifecycle, security, caching, and reporting. Drivers perform immediate queries
and reads, bounded actionability/input, atomic observations, state capture, and
artifacts. Backend defaults cannot silently change portable behavior.

### Registration, not exports

Test modules synchronously register declarations during evaluation. Exports are
ignored. Stable IDs derive from normalized file and title paths. Setup tests
declare session outputs statically, allowing dependency validation before
execution.

### Clean attempts

Each non-serial attempt gets fresh logical driver, fixture, handler, ledger, and
artifact state. Serial groups restore once and retry from member one as a whole.
Timeout/cancellation propagates to model, driver, hooks, resources, artifacts,
and child processes.

### Safe caches

Locate caches store semantic locator expressions, never node references.
Path caches store structured guidance and still use model re-observation. Keys
include test, target, call, input, app, screen, driver, schema, and policy
identity. Replay never silently repeats an action that may have committed.

### Secrets and policy

Secrets are opaque host-side handles accepted only by closed input sinks. The
runner authorizes credential, purpose, origin, frame, and current node before
resolving plaintext. App/model/cache/ledger content is untrusted data. Origin
confinement, production opt-in, pixel/trace masking, path containment, and
explicit trusted-code/CI separation are normative conformance behavior.

### Versioned interoperability

The specification separates SDK, runner, portable driver core, web execution,
driver SPI, agent protocol, report, cache, session, and conformance profiles.
Canonical `.d.ts` files and JSON Schemas take precedence over
examples. Driver and runner conformance use a versioned reference app and
machine-readable requirement IDs.

## Scope

v0 includes web execution, Playwright reference driver, deterministic semantic
surface, agent tiers, setup/sessions, credentials, reports, caches, and security
policy. It excludes mobile execution, cross-run sessions, hosted runners,
hosted/dynamic resource extensions, custom fixtures/reporters, watch/inspector,
sharding, PR selection, and service emulation.

The normative v0 release gate is in spec/07-scope.md. PLAN.md orders the work
but cannot weaken that gate.

## Tradeoffs

- A runner is more work than a helper library, but it is the layer that can own
  lifecycle, policy, cache, and results.
- Backend neutrality requires e2e-owned semantics instead of inheriting every
  Playwright convenience.
- Strict security prevents some unconstrained computer-use behavior by design.
- Per-run sessions sacrifice warm cross-run login until expiry, encryption,
  revocation, and isolation are specified.
- Web-first postpones the headline mobile claim but avoids freezing imaginary
  mobile behavior before conformance hardware exists.

## Adoption

e2e can run beside an existing suite. Migration coverage is enumerated rather
than described as full parity. Teams can use deterministic APIs without a
model, add agentic calls where they pay, and port only supported flows.

## Deferred questions

There are no unresolved v0 contract questions. Post-v0 work must define new
profiles for mobile execution, shared/cloud state, resource extensions,
untrusted remote drivers, and PR-aware testing before changing normative APIs.
