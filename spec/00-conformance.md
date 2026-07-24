# 00 - Conformance and Versioning

This document defines what it means to implement `e2e`. It is normative.

## Requirement language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** are to be interpreted as described by BCP 14 when, and only when,
they appear in all capitals.

Normative material, from highest to lowest precedence:

1. The JSON Schemas under [`schema/`](./schema/).
2. The declarations under [`api/`](./api/).
3. [`conformance/v0-requirements.json`](./conformance/v0-requirements.json) for
   required IDs and profile assignment.
4. Prose in 00 and 02 through 11, 13 through 15.
5. TypeScript blocks explicitly labeled **Normative algorithm**.

01-principles.md, 12-migration.md, all other code blocks, the root README, RFC,
PLAN, examples, and roadmap are informative. An inconsistency with normative
material is a documentation bug; it does not change the normative contract.

## Version

The first frozen contract is **e2e specification 0.1**. It contains these
independently testable profiles:

| Profile | Version | Required by v0 |
|---|---:|---:|
| TypeScript SDK | `sdk-0.1` | yes |
| Runner and CLI | `runner-0.1` | yes |
| Driver portable core | `core-0.1` | yes |
| Web execution | `web-0.1` | yes |
| Driver SPI | `driver-1` | yes |
| Agent protocol | `agent-protocol-1` | yes |
| Report format | `report-1` | yes |
| Cache format | `cache-1` | yes |
| Session format | `session-1` | yes |
| Conformance format | `conformance-1` | yes |
| iOS execution | not assigned | no, future |
| Android execution | not assigned | no, future |

A product MUST list every profile and version it implements. It MUST NOT claim
"e2e v0 conformance" unless it implements every profile marked required above.
Supporting the SDK types without executing web tests is source compatibility,
not v0 conformance.

## Compatibility

Profile versions are independent. A breaking semantic or wire-format change
increments that profile's major version. Additive SDK changes increment the
specification minor version. Implementations MUST reject unsupported major
versions and MUST ignore unknown namespaced entries under an `extensions`
object. Unknown fields elsewhere are invalid.

Config MAY declare `specVersion: '0.1'`. Omission means the runner's current
0.x version. A runner MUST reject a requested version it does not implement.

## Portability guarantees

The standard defines three different guarantees:

- **Source portability:** a test accepted by `sdk-0.1` compiles against every
  conforming SDK package.
- **Deterministic portability:** `screen`, `app`, `web`, lifecycle, selection,
  and result semantics satisfy the same conformance vectors on every
  implementation of the same execution profile.
- **Agentic comparability:** agent calls have the same inputs, limits, policy
  checks, error taxonomy, and report shape. The standard does not promise the
  same model plan or judgment across providers or model versions.

An implementation MUST NOT describe agentic execution as deterministic. A
report MUST identify the model, agent-policy version, driver, cache provenance,
and target needed to compare two runs.

## Conformance suites

The reference package MUST publish machine-executable suites for every required
profile. Each assertion maps to a stable requirement ID such as
`RUNNER-COLLECT-001` or `DRIVER-QUERY-004`. A conformance report contains the
exact implementation artifact name/version/SHA-256, suite version, profile,
requirement ID, status, and evidence in `conformance-1`. Required IDs cannot be
skipped. A profile passes only with no missing, duplicate, unknown, or failed
required IDs.

The driver verifier is defined in [09-drivers.md](./09-drivers.md). Runner
conformance uses the reference web application and fixture suite maintained
with the specification. Self-attestation or a package name is not evidence of
conformance.

A supplied `conformance-1` document is untrusted evidence. To accept a claim, a
consumer MUST obtain the exact artifact by SHA-256 and rerun the matching
reference suite/manifest in a trusted environment. The freshly generated report
is the accepted result. Schema/semantic validation of claimant-created JSON
alone never certifies conformance.

## v0 boundary

v0 executes web targets only. The portable `app`, `screen`, target, and
capability vocabulary is designed for future mobile profiles, but iOS and
Android execution claims are reserved until those profiles and conformance
suites are published. Mobile API sketches in 08-platforms.md are informative
unless incorporated into a later profile.
