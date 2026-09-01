# 03 - Assertions

The canonical matcher declarations are in
[`api/e2e.d.ts`](./api/e2e.d.ts). This document defines `runner-0.1`
assertion behavior.

## Deterministic locator assertions

Locator assertions are runner-owned polling operations. Drivers perform one
immediate query/read per poll; they do not own assertion retries.

The default assertion timeout is `config.assertionTimeout`, 5 seconds. An
explicit matcher timeout overrides it. Polling uses an implementation-selected
interval no longer than 100 ms locally and 250 ms for a remote driver. A runner
MAY react immediately to driver state-change notifications.

Except for `toHaveCount`, a positive matcher requires exactly one matching
node. Zero matches keep polling; multiple matches fail immediately with
`LOCATOR_AMBIGUOUS`. `toHaveCount` evaluates the complete current match set.

`toBeHidden` and negated visibility accept zero matches. Other negated
single-node matchers still require an unambiguous node. A negated condition
passes only after it remains true continuously for a one-second grace window;
the grace window must fit inside the matcher timeout. This prevents a transient
absence from passing immediately.

On timeout, the failure includes the normalized locator expression, final
match count, relevant semantic subtree, last observed value, target, elapsed
time, and an artifact reference. The runner MAY suggest a higher-priority query
but MUST NOT execute the suggestion automatically.

## Matching rules

Text is normalized by trimming leading/trailing whitespace and replacing every
nonempty run of Unicode whitespace with one ASCII space. String matching is
exact by default; `exact: false` performs case-insensitive substring matching.
Regular expressions use ECMAScript source and flags and ignore `exact`.

`toHaveText` compares complete normalized text. `toContainText` uses substring
or regexp matching. `toHaveValue` compares the normalized exposed input value.
`toHaveAccessibleName` uses the profile's accessible-name algorithm.

Visibility, enabled, checked, selected, and expanded states use the normalized
semantic definitions in [08-platforms.md](./08-platforms.md), not raw DOM
attributes. Missing platform state is `false`, except enabled defaults to true
when neither disabled nor unavailable is reported.

## Web assertions

`expect(web).toHaveURL` and `toHaveTitle` use the same timeout and polling
rules. Relative expected URL strings resolve against the target base URL.
String URL matching is exact after WHATWG URL parsing/serialization, including
IDNA ASCII host conversion, dot-segment removal, and default-port removal;
regular expressions test the complete serialized URL.

## Agent assertions

`agent.assert` is a single model judgment, not a retrying matcher. It uses one
atomic observation and rejects false with `ASSERTION_FAILED`. The report keeps
the assertion, sanitized explanation, model provenance, observation revision,
and a redacted screenshot only when `screenshot` is true and pixel evidence is
permitted by security policy. Eventually true natural-language conditions
belong in `agent.waitFor`.

## Plain values

The value matcher set is closed by `api/e2e.d.ts`. Value matchers execute
synchronously and never involve drivers or models. Their observable behavior,
including equality and diff formatting, is pinned to `@vitest/expect` 4.1.10.
An implementation MAY use another engine only when it passes vectors generated
from that exact reference version.

## Future resource matchers

Resource matchers are not part of v0. A future profile may add deterministic,
eventually consistent world-state assertions. Predicate functions are not a
wire-serializable matcher form and will not appear in reports or remote
protocols without an explicit representation.
