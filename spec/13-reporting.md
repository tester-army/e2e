# 13 - Reports and Wire Formats

The JSON Schemas under [`schema/`](./schema/) are normative for `report-1`,
`session-1`, the `agent-protocol-1` judgment/tool messages,
and `conformance-1`. This document defines semantics not expressible in JSON
Schema.

## Common encoding

Wire documents are UTF-8 JSON without a byte-order mark. Writers use two-space
indentation and a trailing newline. Canonical hashes use RFC 8785 JCS rather
than presentation whitespace. Timestamps are RFC 3339 UTC strings with exactly
millisecond precision. Durations are nonnegative integer milliseconds.

Paths use `/`, are relative to project root or the declared artifact root, and
must not contain an empty segment, `.`, `..`, a drive prefix, a leading `/`, or
a NUL byte. Readers resolve paths only after canonicalization and reject
symlink escape.

Regular expressions serialize as `{ "source": string, "flags": string }`.
Dates, `BigInt`, functions, symbols, cycles, class instances, and non-finite
numbers are invalid unless a schema defines an explicit string representation.

Hard document ceilings before read are 100 MiB for report, 64 MiB for session,
10 MiB for conformance, and 256 KiB for each agent protocol
message. Config may lower the report ceiling but cannot raise these values.

Writers MUST emit only schema-defined fields. Extensions live under an
`extensions` object keyed by a reverse-DNS or npm-package namespace. Readers
ignore unknown extension keys and reject unknown core fields.

## Stable identity

- Run IDs and attempt IDs are lowercase UUIDv7 strings.
- Test IDs follow the file/title-path algorithm in 11-lifecycle.md.
- Result ID is SHA-256 of `{ testId, targetId }`, encoded as lowercase hex.
- Step ID is `<attempt-id>:<zero-based-step-index>`.
- Artifact IDs are `<attempt-id>:artifact:<zero-based-artifact-index>`.
- Serial-group ID is SHA-256 of `{ serialId, targetId }`; serial member step ID
  is `<group-attempt-id>:member:<member-index>:<step-index>`.

IDs never contain secrets, absolute paths, random model text, or backend node
references.

## `report-1`

`report-v1.schema.json` is the canonical run document. It contains runner and
environment provenance, resolved target/backend manifests, every discovered
test-target result (including filtered/skipped pairs), all attempts, steps,
artifacts, errors, cleanup outcomes, and selection counts.
Target provenance includes the backend name/version/contract version, the
declared capability set (harness capabilities plus contributed fixture names),
artifact capabilities, state capability, origin, and environment. The target's
`allowProduction` field is retained for `report-1` readers and is derived:
`true` exactly when `environment` is `production`. It leaves the wire format
in the next schema version.
`artifactCapabilities` lists the configurable kinds a backend can produce on
request, `screenshot` and `trace`; `video` is not a configurable capability,
though it remains a valid kind for a fixture to attach. The report carries no
platform noun and no backend method name: a step that changes the viewport
records the resulting viewport on that step as an optional field, and nothing
else about the surface is assumed.

The only inventory exception is collection failure before expansion due to the
discovered-result limit. That error report contains no results and zero summary
counts, avoiding an unbounded report while preserving the typed run error.

`configDigest` is SHA-256/JCS of resolved config after replacing credential
material and model API keys with `{ secretName }`, replacing backend handles with
their manifests, normalizing paths relative to project root, and omitting
ambient environment values not represented in config. Every `app.command.env`
value is replaced by `{ envName: key }`; no environment value contributes to
the digest. Base URLs cannot contain queries, userinfo, or fragments.

### Ordering

Targets use config order and contiguous `index`. Results use normalized file
order, `declarationIndex`, then target index, regardless of completion time.
Serial groups use the same file/declaration/target ordering. Attempts and steps use
ascending index. Artifacts use creation order. Reporters MUST preserve this
order.

### Status

Run status is `passed`, `failed`, `error`, or `interrupted`:

- `passed`: process exit 0;
- `failed`: process exit 1;
- `error`: process exit 2, 3, or 4;
- `interrupted`: process exit 130.

Result status is `passed`, `flaky`, `failed`, `timed-out`, `interrupted`, or
`skipped`. A non-serial skipped result has no attempts and every skipped result
has a machine-readable cause. An ordinary flaky result has at least two attempts
and ends in a passed attempt. Serial-member results have no independent attempts;
their status derives from the first-class serial group. A serial group and all
members are flaky when a later complete group attempt passes.

Summary counts are recomputed from results: `discovered` is result count;
`selected` excludes file/tag/platform/capability-filtered pairs; `executed`
counts non-serial results with a non-skipped attempt and serial results with a
non-skipped member execution; final status populates passed,
failed/timed-out/interrupted, flaky, or skipped.

### Errors

Errors contain runner-assigned category, code, sanitized message, retryability,
and optional phase/scope/source. Suite-hook errors identify their suite scope.
Model explanations are data inside a step and do
not replace the runner message or code. A primary error is followed by ordered
secondary teardown/cleanup errors.

Stacks are optional, project-root-relative, source-mapped, and sanitized. Core
error/event objects contain no open metadata bags; recognized extensions are
validated against their own schema before a trusted consumer uses them. A
report MUST NOT include environment values, authorization headers, cookies,
session payloads, provider requests/responses, or raw backend dumps.

### Steps and events

Top-level step boundaries follow 10-determinism.md. Polls, model calls,
observations, tool proposals, policy decisions, backend operations, and schema
validation are child events. Events record metadata and counts, not sensitive
payloads. Core event metadata is limited to bounded name, count, byte, decision,
code, and detail fields defined by the schema.

A committed backend action's event carries `detail`: bounded, redacted prose
for what the action did — `tap button "Approve"`, `fill secret "password"
into textbox "Password"` — with the same wording as the recorded trace
summaries (10-determinism.md), so a live reporter can render the act without
a side lookup. Secret values never appear; the secret's stable name stands
in. Every string passes the run's redactor before it can reach the event.

A step whose model input included pixel evidence records that pixels were model
input, not merely an artifact, plus the largest image sent in bytes. A step that
asked for pixels and did not send them records why they were withheld:
`PIXEL_TAINTED`, `MASKING_UNPROVEN`, or `UNSUPPORTED_CAPABILITY`. A step run under `vision: "only"`
records that the semantic tree was withheld, and reports zero observation bytes,
because the observation contributed nothing to the request.

Every model-backed step identifies provider, model ID, resolved endpoint (`local`
or URL),
adapter version, agent-policy version, call count, and token/cost usage when
reported by the provider.

### Artifacts

Artifacts have generated IDs and contained relative paths. Their media type,
kind, redaction status, and producer are recorded. Persisted artifacts also have
byte size, SHA-256 digest, and path, and — when the run configured an
`ArtifactStore` that accepted the artifact — the store's own reference as
`ref` beside the path. `redaction: incomplete` artifacts MUST NOT
be persisted or exposed to a model; their report entry has no path, size, or
digest to avoid a secret-value oracle.

### Partial reports

The runner builds reports in memory or an append-safe journal and atomically
replaces the final JSON file. On interruption or infrastructure failure it
writes every completed record plus active attempts marked interrupted. A
truncated JSON document is never a valid partial report.

Every run writes `report-1`, independent of selected renderers.

## Semantic validation

JSON Schema validation is only the first pass. Before a report is trusted or
rendered, the reference semantic validator MUST:

1. enforce byte limits before reading, reject duplicate object keys while
   parsing, then enforce depth/string/array/event limits before schema or use;
2. recompute UUID/result/step/artifact identities and all references;
3. verify target/result/attempt/step ordering;
4. derive result status from attempts and run status from exit code;
5. recompute summary counts and reject discrepancies;
6. verify flaky/serial/skip invariants and error placement;
7. verify artifact path containment, size, digest, producer, and redaction;
8. reject forbidden core payloads and unrecognized interpreted extensions.

A schema-valid document that fails semantic validation is untrusted and cannot
be rendered by a privileged reporting job. The validator is part of the future
runner implementation, not a standalone specification-repository script.

## `session-1`

`session-v1.schema.json` wraps AES-256-GCM encrypted backend state with run,
target, backend, platform, app identity, creation, required expiry, IV, tag, and
ciphertext. All cleartext metadata is authenticated additional data using JCS.

The IV is a unique random 96-bit value for the per-run key and session write;
the authentication tag is 128 bits. The exact AAD object is the complete
envelope excluding `state.tag` and `state.ciphertext`, while retaining
`state.format`, `state.version`, `state.algorithm`, `state.iv`, and extensions.
The runner tracks IVs for the key lifetime and rejects reuse.

Session payloads are bearer credentials. They never enter reports,
model context, or artifacts. v0 stores them only for one runner invocation,
with verified owner-only permissions; inability to enforce those permissions
fails before capture. The runner then deletes them during cleanup.
A validation or cleanup failure is surfaced; the runner never falls back to a
different target's session.

## `conformance-1`

`conformance-v1.schema.json` records one implementation artifact against one
profile version. It identifies package name/version, SHA-256 artifact digest,
suite version, manifest SHA-256, timestamps, every required requirement ID, pass/fail, and bounded
evidence references. Required IDs cannot be skipped. Overall status is derived;
semantic validation rejects missing, duplicate, or unknown IDs for that suite.
Validation proves internal document consistency, not truthful execution. A
conformance claim is accepted only through the trusted rerun procedure in
00-conformance.md.

## Compatibility

Schema-version major changes are breaking and use a new `schemaVersion` value
and file. Readers reject unsupported versions. A runner MUST NOT guess a newer
format or silently coerce invalid fields.
