# Implementation Plan

The specification is the contract. v0 is released only after Phase 3 and must
implement every required profile in `spec/00-conformance.md`.

## Phase 0 - Specification freeze

- canonical `sdk-0.1` and `driver-1` declarations;
- complete collection/lifecycle/session state machine;
- runner-owned query/wait/action semantics;
- normative agent-tool/report/cache/session/conformance schemas;
- mandatory security and cancellation behavior;
- coherent web-only v0 scope and examples.

**Exit:** `npm run check` type-checks canonical declarations and examples,
cross-document review finds no unresolved v0 decisions, and changes after
freeze require an explicit specification revision. Schema/semantic validators
land with their implementation profiles.

## Phase 1 - Deterministic runner and reference driver

Runner foundation:

- config/project discovery and TypeScript/ESM loading;
- synchronous collection, stable IDs, filtering, targets, workers;
- hooks, clean attempts, retries, serial-group retries, cancellation, cleanup;
- setup dependency graph and per-run sessions;
- list reporter, `report-1` data model, exit-code precedence;
- structured app process and signal handling.

Web profile:

- immutable locator AST and runner polling/strictness;
- `screen`, `Locator`, deterministic assertions;
- `app` lifecycle and state capture/restore;
- `web` navigation, routes, frames, evaluation, cookies, dialogs, downloads,
  keyboard/mouse;
- screenshot/trace/video artifacts;
- `e2e/playwright` behind `driver-1`.

Conformance:

- reference web application;
- requirement-ID harness for every Phase 1 profile behavior;
- cancellation, action-commit, secure-field, state, and artifact vectors;
- JSON Schema validation for every generated report/session.

**Exit:** the named migration fixture suite ports without backend escape hatches;
every required Phase 1 ID passes under the pinned Chromium, Firefox, and WebKit;
fault-injection IDs prove cancellation and cleanup.

## Phase 2 - Agent, policy, and cache

Agent orchestration:

- explicit model adapter/config and provenance;
- bounded invocation engine, tool schemas, ledger truncation;
- `act`, located actions, assisted waits, login, extract, assert;
- Standard Schema v1 validation/repair;
- runner-owned typed error classification.

Security:

- origin/frame/navigation policy and production opt-in;
- opaque credentials and purpose-scoped host-side fills;
- atomic redacted observations, secure pixel regions, trace filtering;
- prompt/tool injection, path/report/terminal/HTML hardening;
- untrusted-CI read-only defaults and resource quotas.

Caching/reporting:

- `cache-1` keying, canonical hashing, locks, atomic writes;
- locate replay and guarded path guidance;
- nested model/policy/cache events in `report-1`;
- JSON and CSP-protected local HTML reporters.

**Exit:** 100 clean/reset repetitions of the mixed-tier fixture suite pass;
locate-cache hit vectors use zero model calls; injected path divergence never
duplicates a committed action; every required security ID passes.

## Phase 3 - Dogfood and v0 release

- run TesterArmy's web suite on e2e locally and in GitHub Actions;
- use locked local CLI, frozen dependency graph, SHA-pinned actions;
- gate changes on SDK type tests, schemas, runner/driver/security conformance;
- exercise setup/session failure, retries, interrupted runs, partial reports,
  cache corruption, provider failure, and app-process crashes;
- tune diagnostics, authoring latency, and report usability without changing
  frozen semantics accidentally.

**Exit:** at least 100 consecutive gating CI runs span at least 14 days without
bypass; no known normative mismatch remains; every required v0 profile emits a
valid passing `conformance-1` report with no missing or skipped ID.

This phase maps to the normative release gate in spec/07-scope.md; that document
wins if this plan drifts.

## Phase 4 - Authoring loop and extensions

Re-evaluate, specify, and version only what dogfood justifies:

- watch mode and inspector;
- sharding and custom reporters;
- `test.each`, conditional modifiers, custom fixtures;
- email first, then file/webhook resources;
- visual and clock profiles.

Each addition starts as a specification change with declarations, wire impact,
security review, and conformance vectors.

## Phase 5 - Mobile v1

- define iOS and Android app identity, navigation/deep-link, state, permission,
  accessibility, actionability, artifact, and destructive-device policy;
- publish mobile reference apps and device/simulator conformance harnesses;
- implement `e2e/agent-device` only after those profiles freeze;
- prove one portable test against web, iOS, and Android.

**Exit:** mobile profiles are normative and green; only then may project
positioning claim current cross-platform execution.

## Phase 6 - Hosted and PR profiles

Revalidate cloud, managed resources, shared state, PR selection, and service
emulation against the implemented core. Hosted execution requires bundle,
tenant, token, encryption, retention, audit, cancellation, and report-version
protocols before the one-switch promise becomes normative.

## Engineering rules

- Conformance tests land with each behavior, not after implementation.
- A profile cannot skip required vectors.
- Implementation shortcuts do not amend the specification.
- Spec changes update declarations, schemas, prose, examples, and tests in one
  review.
- Scope is cut before correctness, isolation, security, or diagnostics.
