# 15 - Required Conformance Matrix

This document and [`conformance/v0-requirements.json`](./conformance/v0-requirements.json)
define the complete required-ID set for specification 0.1. The JSON manifest is
normative when IDs or profile assignment differ; numbered behavioral documents
remain authoritative for requirement meaning.

Every manifest entry is REQUIRED. A profile suite version identifies the exact
manifest digest it implements. A `conformance-1` report must contain every ID
assigned to its profile exactly once, with `passed` or `failed`. There is no
skip/not-applicable state for v0 requirements.

Published reports are self-asserted until a consumer reruns the reference suite
against the digest-pinned implementation artifact in a trusted environment.

The matrix covers:

- strict SDK declarations and examples;
- config, collection, selection, lifecycle, retries, sessions, CLI, and
  untrusted mode;
- portable driver query/action/observation/state behavior;
- web semantics and all three required browser engines;
- launch, cancellation, commit, cleanup, artifact, and capability SPI behavior;
- the closed model tool grammar and runner policy boundary;
- report schema plus semantic validation;
- cache identity, safe replay, locking, and poisoning behavior;
- encrypted per-run sessions;
- conformance report identity, completeness, and evidence.

Security vectors use hostile app text, frames, redirects, model output, cache
documents, report documents, paths, terminal strings, screenshots, traces, and
forced cancellation. Passing happy-path API tests alone cannot satisfy a
profile.

When a normative change adds, removes, or changes a required behavior, the
manifest, suite version, affected declarations/schemas, and implementation
conformance reports must change in the same review.
