# 07 - Frozen v0 Scope

v0 is the complete implementation of the required profiles in
[00-conformance.md](./00-conformance.md). It is web-only, local-runner-first,
and requires no account or hosted e2e service.

## Included

SDK and runner:

- synchronous registration with `test`, skip/only, hooks, nested groups, and
  whole-group serial retries;
- setup tests with statically declared per-target sessions;
- deterministic selection, targets, workers, retries, timeouts, cancellation,
  teardown, and exit codes;
- strict TypeScript/ESM loading behavior;
- list and `report-1` JSON reporters.

Agent:

- planning with `act`, extraction, assisted `waitFor`, and one-shot assertion;
- explicit model configuration, action/model/observation budgets, bounded
  ledger, typed runner-owned errors;
- origin, secret, observation, artifact, and prompt-injection policy from
  14-security.md.

Deterministic web profile:

- `screen` queries, complete `Locator` surface, and async matchers;
- `app` web lifecycle and per-run state sessions;
- `web` navigation, selectors/frames, evaluation, routes/responses, cookies,
  dialogs, downloads, viewport, keyboard, and mouse;
- screenshot, trace, and video through the reference Playwright driver;
- public `driver-1` SPI and executable `core-0.1`/`web-0.1` verification.

Resources and tooling:

- named host-side credentials with origin-scoped opaque secrets;
- strict config, implicit single-web-target path, structured app process;
- `e2e init` and `e2e run`;
- versioned report, session, and conformance formats;
- secure GitHub Actions guidance.

## Explicitly excluded

- iOS and Android execution profiles;
- cloud/hosted runners and hosted or dynamic resource extensions;
- cross-run session reuse;
- email, webhook, file, phone, and service-emulator extensions;
- `test.each`, conditional/expected-failure modifiers, and `test.extend`;
- global hooks, sharding, watch mode, inspector, custom reporters/matchers;
- multi-tab/popups, visual snapshots, HAR, clock control, scheduling;
- PR-aware selection/dynamic testing;
- raw backend objects and model/portable raw-coordinate targeting. Trusted
  deterministic `web.mouse` coordinates remain included in the web capability.

Reserved future declarations do not constitute runtime support. A v0 runner
rejects a configured unsupported platform or capability rather than ignoring
or pretending to run it.

## Local and offline

"Local" means execution and artifacts can stay on the user's machine with no
e2e account or hosted runner. Deterministic tests run without a model and can be
offline after dependencies are installed. Agent tests are offline only with a
local no-egress model adapter. Documentation MUST NOT claim all agent tests are
fully offline.

## Release gate

An implementation may identify itself as v0 conforming only when:

1. Every required profile emits a valid `conformance-1` report with no missing,
   duplicate, unknown, skipped, or failed required IDs.
2. `web-0.1` passes unchanged on the pinned Chromium, Firefox, and WebKit
   versions shipped by that implementation's web driver.
3. Fault-injection vectors pass for cancellation, forced realm termination,
   partial launch rollback, action commit ambiguity, session corruption,
   hostile reports, redaction, origin policy, and process cleanup.
4. There is no known normative spec/implementation mismatch, unresolved v0
   decision, or skipped required conformance assertion.

The reference `e2e` package has two additional release criteria:

1. Repository `npm run check` type-checks canonical declarations and examples
   in the SHA-pinned CI workflow; implemented profile suites validate schemas,
   hostile wire inputs, and semantic requirements.
2. The dogfood suite completes at least 100 consecutive gating CI runs spanning
   at least 14 days with no disabled required vector or manual bypass.

PLAN maps implementation phases to this gate but cannot weaken it.
