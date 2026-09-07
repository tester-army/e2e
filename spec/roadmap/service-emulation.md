# Roadmap - Service Emulation

This document is nonnormative. Service emulators are extension packages, not a
core `services` fixture or reserved root API.

## Goal

Provide local, stateful substitutes for external test-world systems such as
payments, Slack, OAuth, email delivery, and webhook receivers, with deterministic
seed/inspect/reset APIs and world-state assertions.

## Extension shape

A service package owns:

- its import path and TypeScript declarations;
- namespaced config and exact engine version;
- per-attempt resource handles and finalizers;
- local process/network lifecycle;
- deterministic seed, inspect, reset, and matcher semantics;
- report events and JSON-safe match values;
- secret, PII, retention, and redaction policy;
- local and optional hosted engine conformance.

It must not add a universal fixture. A future package could expose imports such
as `stripeTest.sandbox()` or `slackTest.channel()`; exact names remain undecided.

## Isolation

The default namespace is one test attempt, including retries. Every endpoint
binds to a random loopback-only port, requires an unguessable per-attempt token,
and rejects other namespaces. State resets before acquisition and is destroyed
after teardown.

Parallel tests never share captured messages, payment state, ports, webhook
tokens, or failure injection. File-level/run-level sharing requires an explicit
future API and cannot change between local and CI defaults.

## Network and app connection

The runner passes endpoint/token configuration to an app process through an
explicit extension contract. It never prints bearer values. Emulators restrict
outbound destinations; webhook delivery signs events and targets only allowed
app origins.

The design must explain remote preview connectivity without exposing a local
emulator publicly or silently switching to a managed service.

## Assertions

World-state matchers are deterministic polling operations with closed,
wire-safe match objects. Predicate functions and executable callbacks are not
portable matcher values. Negation, timeout, ordering, duplicate events, and
clock semantics require conformance vectors.

## Hosted variants

A managed sandbox uses the same extension API only after tenant/branch/run
isolation, short-lived credentials, encryption, retention, audit, cancellation,
quota, and report-version requirements are normative.
