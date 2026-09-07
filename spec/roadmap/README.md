# Roadmap

Everything here is informative and outside specification 0.1. Code blocks are
design sketches, not reserved APIs. A roadmap item becomes real only through a
new profile with canonical declarations, wire-format impact, security review,
and executable conformance vectors.

## Candidate profiles

| Candidate | Required work before adoption |
|---|---|
| iOS/Android | app identity, deep links, accessibility projection, actionability, state, permissions, device safety, reference apps |
| Resource extensions | package-owned imports/config, attempt ownership, local engine, report events, secret/PII policy |
| Watch/inspector | rerun invalidation, live-session policy, report/event compatibility |
| Sharding | deterministic assignment, setup/session fan-out, report merge schema |
| Cloud runner | execution bundle, tenant/token isolation, encryption, cancellation, profile negotiation |
| PR testing | untrusted-code split, selection completeness, preview policy, trusted reporting |
| Service emulation | extension imports, per-attempt namespaces, authenticated loopback endpoints, deterministic reset |
| Visual/clock/HAR | dedicated deterministic semantics and artifact/security formats |

## Deferred SDK conveniences

`test.each`, conditional modifiers, expected failures, custom fixtures,
custom matchers/reporters, step grouping, cross-run session reuse, credential
store CLI, migration codemod, and file/email/webhook/phone resources remain
unspecified.

No roadmap design may add a universal fixture casually. Integrations use
extension packages; platform-family capabilities use namespaced driver
fixtures. Managed engines must preserve the same test source and normative
profile behavior, not merely similar method names.
