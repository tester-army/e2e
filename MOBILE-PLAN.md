# Mobile Driver Plan (`@e2edev/agent-device`)

**Status:** executing
**Created:** 2026-07-29
**Scope:** PLAN.md Phase 5 — Mobile v1, iOS + Android simulators/emulators only

## Goal

Ship `@e2edev/agent-device`, a `driver-1` implementation backed by
[agent-device](https://oss.callstack.com/agent-device/docs/client-api)'s typed
Node client, and lift the runner gates that currently reject mobile targets.

## Context

The SPI is already platform-neutral: `swipe`, `longPress`, `Momentum`,
`tapPoint?`, and `dispose` (documented for "booted simulator, or device lease")
exist for exactly this. `Platform`, `Capability`, `MobileTarget`, and the
`Device` fixture are reserved vocabulary in both `spec/api/e2e.d.ts` and
`packages/e2e/src/types.ts`.

Three hard gates block mobile today:

1. `config/resolve.ts:355-360` rejects any non-`web` platform with
   `PLATFORM_UNSUPPORTED`, and `ResolvedTarget.platform` is hard-typed `'web'`
   with a required `browser`.
2. `run/fixtures.ts:154-159` — the `device` getter always throws.
3. `spec/08-platforms.md:246-252` states mobile execution requires dedicated
   profiles and conformance vectors, and that a v0 runner MUST reject mobile
   targets. So this is a specification revision, not just an implementation.

`agent-device@0.20.2` is the target version. It needs Node >= 22.12, has only
two runtime deps (`@limrun/api`, `yaml`), ships its own Apple/Android runner
assets, and talks to a local daemon it spawns. Only its `ios` and `android`
platforms are in scope; `web`, `macos`, `linux`, `vega`, and `tv` targets are
explicitly out.

Settled scope calls (2026-07-29):

- The `mobile-0.1` profile is frozen as part of this work, not deferred.
- `packages/e2e` is unreleased, so breaking changes to `ResolvedTarget`,
  `DriverContext`, and config shape are in scope.
- The driver ships as its own package, so web-only users pay nothing for it.
- Simulators and emulators only. Physical devices are a later profile.
- No Metro / React Native dev-server integration.
- Snapshots are captured with `raw: true`.

### Relevant agent-device surface

Everything the driver needs exists on the typed client:

| Need | agent-device |
|---|---|
| session + app launch | `apps.open`, `apps.close`, `sessions.close` |
| semantic tree | `capture.snapshot` |
| element actions | `interactions.click / longPress / fill / focus / scroll` |
| coordinate actions | `interactions.click({x,y})`, `swipe`, `pan` |
| navigation | `command.back / home / appSwitcher / orientation` |
| deep links | `apps.open({url})` |
| reset | `settings.update({setting:'clear-app-state'})` |
| artifacts | `capture.screenshot({path})`, `recording.record({action,path})` |
| device fixture | `command.keyboard`, `settings.update({permission/location})`, `apps.push` |
| device discovery | `devices.list`, `devices.capabilities` |

Notable shape facts that drive the design:

- `SnapshotNode` is a **flat** array with `index` / `parentIndex` / `depth`. No
  `children`, no `text`, no `visible`, no `editable`. Text lives in `label` /
  `value`; visibility is `visibleToUser` + `hittable`; test IDs are `identifier`.
- `CaptureSnapshotResult.refsGeneration` is the ref-frame epoch that `@eN` refs
  were minted from — a ready-made observation revision.
- `capture.screenshot` returns a **path** plus measured `width`/`height`/
  `pixelDensity`. There is no buffer or base64 field, and no masking primitive.
- No types are exported from the package root; only `createAgentDeviceClient`,
  `AppError`, `centerOfRect`, and the error helpers. Types must be derived
  structurally (`ReturnType`/`Parameters`/`Awaited`) or imported from
  `agent-device/contracts` and `agent-device/selectors`.
- `AppError.code` is an open union over 16 known codes
  (`DEVICE_NOT_FOUND`, `UNSUPPORTED_OPERATION`, `AMBIGUOUS_MATCH`, …).

## Approach

Mirror the structure of `packages/playwright/src/*`: a thin
`defineDriver` factory plus a session class, with the semantic translation split
into focused modules.

**The driver owns e2e semantics; agent-device is used only as a device
transport.** Concretely: the driver calls `capture.snapshot` and evaluates the
runner-supplied `LocatorExpression` against the resulting tree **in process**,
then dispatches actions by `@eN` ref. It does not use agent-device's
`selectors`, `finders`, `find`, `is`, or `wait` commands.

Rationale: the e2e query model is closed and normative (role/label/placeholder/
text/displayValue/testId, `TextPattern` exact-vs-regexp, scope, `filter({hasText, has})`,
`index`, runner-owned cardinality and polling). agent-device's selector-chain
vocabulary is a different, lossy language, its `find` resolves *and mutates* in
one call, and its `wait` adds hidden retries that `spec/09-drivers.md:120`
forbids. Reimplementing resolution over the snapshot tree is both simpler and
the only way to stay conformant.

Layer sketch:

- `index.ts` — `agentDevice(options?)` factory, manifest, device-pool `dispose`.
- `client.ts` — client construction, session naming, daemon lifecycle.
- `session.ts` — `DriverSession`: `app`, `screen`, `actions`, `artifacts`,
  `observe`, `runtime`, `close`, `capabilityFixtures.device`.
- `snapshot.ts` — flat → nested `SemanticNode` tree, ref/revision binding,
  per-field truncation to `OBSERVED_NAME_LIMIT` / `OBSERVED_TEXT_LIMIT`.
- `roles.ts` — platform role normalization tables.
- `locators.ts` — `LocatorExpression` evaluation over the snapshot tree.
- `actions.ts` — `LocatorAction` → `interactions.*`, actionability pre-checks.
- `device.ts` — the `Device` capability fixture.
- `support.ts` — `AppError` → `DriverError` translation, path containment.

## Key Decisions

### 1. Packaging: its own package, `@e2edev/agent-device`

The driver was first written as an `e2e/agent-device` subpath with `agent-device`
as an optional peer, on the assumption that extraction would be a later refactor
that also moved the Playwright driver. That refactor landed first, so the driver
ships as `packages/agent-device`: `@e2edev/agent-device`, depending on `e2e` as a
peer and owning `agent-device` outright. A web-only project installs neither, and
`e2e` carries no mobile peer at all.

Every module under `packages/agent-device/src/*` imports only from `e2e/driver`,
`e2e/internal`, and `agent-device` — never from runner internals.

It is deliberately **not** in the well-known driver registry that resolves
`driver: 'playwright'`. `MobileTarget.driver` is a required `DriverHandle` in the
frozen `spec/api/e2e.d.ts`, so a mobile target imports `agentDevice()` rather
than naming a string; adding a string id would contradict the spec rather than
extend it.

### 2. Revision model: `refsGeneration` is the revision

`NodeRef = { id: '@e12', revision: String(refsGeneration) }`. Every `read` /
`perform` re-captures cheaply or reuses the cached tree for the current
generation; a ref whose generation no longer matches the live one is
`NODE_STALE` with `retryable: true`, which is exactly what the runner's
`LocatorEngine` already retries. Where the daemon omits `refsGeneration`, the
driver mints a synthetic monotonic revision per capture and invalidates on every
mutation.

### 3. Snapshots are captured raw

`capture.snapshot` defaults to a visible-first, token-efficient view that
collapses off-screen interactive content into prose summaries like
`[off-screen below] 3 interactive items`. That would make a locator resolve to
zero matches for an element that genuinely exists below the fold, silently
breaking `count`, `scrollUntilVisible`, and `scrollTo`.

The driver therefore always passes `raw: true` and never `interactiveOnly` or
`depth`. Token cost is irrelevant here — the tree is consumed by the driver's own
matcher, and the runner separately bounds what reaches a model via
`observe`/`OBSERVED_*_LIMIT`. `spec/09-drivers.md:120` also forbids hidden query
retries, so a truthful full tree is the only conformant input.

### 4. Role normalization is the profile's normative core

agent-device reports platform-native roles/types (`button`, `text`, `other`,
`navigation-bar`, Android class names). The e2e query vocabulary needs a stable
mapping to ARIA-ish role names. This table is the single largest source of
cross-platform behavioral difference, so it belongs in the spec as a normative
table with conformance vectors, not buried in driver code.

Query mapping:

| e2e query | mobile source |
|---|---|
| `role` | normalized `role` / `type` / `subrole` |
| `label` | `label` |
| `text` | `label`, else `value` |
| `displayValue` | `value` |
| `testId` | `identifier` (React Native `testID`) |
| `placeholder` | **no equivalent field** — see open questions |

`SemanticQuery.states` maps to `enabled` (inverted for `disabled`), `selected`,
`focused`, and `visibleToUser` (for `hidden`). `checked` and `expanded` have no
first-class field; they come from role-specific `value` conventions or are
declared unsupported per platform.

### 5. State capability: `false` in v1

agent-device exposes `clear-app-state` but no app-data-container *capture*, so
faithful `captureState`/`restoreState` is impossible. `spec/09-drivers.md:199-201`
is explicit: a driver that cannot faithfully capture every required store MUST
NOT declare the capability. Consequence: `test.setup` and session reuse are
unavailable on mobile and correctly fail `UNSUPPORTED_CAPABILITY`;
`app.clearState()` still works.

### 6. Artifacts: screenshot + video, no trace

`screenshot` (required by every profile) maps to `capture.screenshot({path})`;
`video` maps to `recording.record({action:'start'|'stop', path})`. There is no
portable iOS+Android equivalent of a Playwright trace, so `trace` is omitted
from the manifest and configuring it becomes a pre-run `UNSUPPORTED_ARTIFACT`
error — which the runner already enforces before launch.

### 7. Vision tier degrades instead of leaking

There is no masking primitive: `capture.screenshot` writes a PNG to disk, and
the driver has no image editor. So when the current tree contains any secure
node, `observe` **omits** `pixels` entirely (explicitly allowed by
`spec/09-drivers.md:166-168`). Otherwise it returns pixels with
`maskedRegionCount: 0` and `complete: true`, using the measured `width`/`height`
and `pixelDensity` as `scale`. `redaction.complete: false` is never returned,
because the runner would reject the observation anyway.

Secure-node detection: iOS `XCUIElementTypeSecureTextField` type, Android
password input types. Their `value` and `text` are stripped from the tree and
`inputPurpose` is set from the same signals.

### 8. Session lifecycle: one agent-device session per driver instance

One driver instance per worker (`spec/09-drivers.md:73-78`), so one named
agent-device session per instance — `e2e-<runId>-<targetName>-<pid>` with
`lockPolicy: 'reject'` and `lockPlatform` pinned. The booted simulator/emulator
is retained across attempts; `dispose` calls `sessions.close`. This is precisely
the retained-device-lease case `dispose` was specified for. Per-attempt
isolation comes from `clear-app-state` + relaunch inside `launch`, not from
rebooting the device.

`agent-device`'s own docs warn against parallel mutating commands on one
session, which matches the SPI's strict serialization guarantee — no extra
locking needed.

### 9. `app` semantics on mobile

| e2e | mobile |
|---|---|
| `open(undefined)` | `apps.open({app})` |
| `open(path)` | deep link against the target's URL scheme |
| `restart()` | `apps.open({relaunch: true})` |
| `clearState()` | `clear-app-state` then relaunch |
| `back()` | `command.back()` (defaults to in-app) |
| `deepLink(url)` | `apps.open({url})` |

`app.baseUrl` is web-shaped and required in `DriverContext`. Mobile app identity
lives on `MobileTarget.app`. Making `DriverContext.app.baseUrl` optional is an
additive SPI change and must be mirrored in `spec/api/driver.d.ts` or
`check:driver-drift` fails.

### 10. Actionability and commit safety

`perform` checks `visibleToUser`, `hittable`, and `enabled` on the resolved node
before dispatch, polling within the supplied operation budget only (never
re-resolving — that is runner-owned). Failures before dispatch are
`NOT_ACTIONABLE`; any failure once a tap/type/gesture may have reached the app is
`ACTION_MAY_HAVE_COMMITTED` with `retryable: false`.

`AppError` translation, roughly: `DEVICE_NOT_FOUND` / `APP_NOT_INSTALLED` /
`TOOL_MISSING` → `DRIVER_FAILURE`; `UNSUPPORTED_OPERATION` / `NOT_IMPLEMENTED` /
`UNSUPPORTED_PLATFORM` → `UNSUPPORTED_CAPABILITY`; `SESSION_NOT_FOUND` →
`INVALID_STATE`; timeouts → `OPERATION_TIMEOUT`; abort → `CANCELLED`; everything
else → `DRIVER_FAILURE`. `AMBIGUOUS_MATCH` should be unreachable, since the
driver never delegates resolution.

### 11. `device` capability fixture

The reserved `Device` interface maps cleanly and needs no changes:
`home` → `command.home`, `hideKeyboard` → `command.keyboard({action:'dismiss'})`,
`openUrl` → `apps.open({url})`, `setLocation` → `settings.update({setting:'location', state:'set'})`,
`setPermission` → `settings.update({setting:'permission'})` with
allow/deny/unset → grant/deny/reset, `pushNotification` → `apps.push`.

Delivered through `DriverSession.capabilityFixtures.device`; the runner's `device`
getter changes from unconditional throw to reading that entry, throwing only when
the driver did not declare it.

## Tasks

Ordered; each is independently reviewable.

### Specification — freeze `mobile-0.1` (blocking)

- [ ] Write `spec/16-mobile.md` defining `mobile-0.1`: simulator/emulator-only
      device scope, app identity, navigation and deep-link mapping, accessibility
      projection, the normative per-platform role normalization table, the query
      mapping table (including `placeholder` and unsupported role states),
      actionability, permission semantics, artifact set, `state: false` posture,
      redaction/pixel-omission rule, and destructive-device safety.
- [ ] Amend `spec/08-platforms.md:246-252` and `spec/00-conformance.md` to make
      iOS/Android assigned rather than reserved, and add `mobile-0.1` to the
      profile table and `spec/15-conformance-matrix.md`.
- [ ] Make `DriverContext.app.baseUrl` optional in `spec/api/driver.d.ts` and
      `src/driver/index.ts` in one change; extend `DriverProfile` with
      `'mobile-0.1'`. Keep `tests/contract/driver-spec-drift.ts` green.
- [ ] Add `mobile-0.1` requirement IDs to `spec/conformance/v0-requirements.json`.
- [ ] Add a mobile example under `spec/examples/` and unfilter
      `spec/examples/tests/notifications.e2e.ts` so `check:spec` covers the
      `device` fixture.

### Runner gates

- [ ] Turn `ResolvedTarget` into a discriminated union over platform so `browser`
      and `viewport` are web-only and `app`/`device`/`os` are mobile-only; replace
      the `PLATFORM_UNSUPPORTED` rejection with real mobile validation. Keep
      `computeConfigDigest` deterministic across processes.
- [ ] Allow a config with no `app.baseUrl` when every selected target is mobile,
      and keep `APP_URL` mandatory for web targets.
- [ ] Wire the `device` fixture from `session.capabilityFixtures`, replacing the
      unconditional throw, with step recording consistent with `app`/`web`.
- [ ] Make capability-driven selection and pre-flight artifact validation work
      for a mobile manifest (no `web` fixture, no `trace`).

### Driver

- [ ] Stand up `packages/agent-device` with locally derived types for the client
      surface, and enforce the internals-free import boundary.
- [ ] Implement the factory, manifest, client/session bootstrap, and
      instance-retained device lease with idempotent `dispose`.
- [ ] Implement snapshot projection: flat → nested tree, ref/revision binding,
      secure-node masking, `inputPurpose` derivation, field truncation.
- [ ] Implement `LocatorExpression` evaluation over the tree: all six queries,
      scope, both filters, `index`/`first`/`last`, document-order stability.
- [ ] Implement `screen.read`, `screen.perform` with actionability and commit
      safety, and `screen.swipe` with the normative momentum distances/durations.
- [ ] Implement `DriverAgentActions` including `tapPoint` via coordinate click.
- [ ] Implement `app` lifecycle and per-attempt isolation.
- [ ] Implement `observe` (atomic tree + optional pixels), `runtime` (viewport,
      scale, device provenance), and idempotent `close`.
- [ ] Implement `artifacts` — screenshot and video, path-contained beneath the
      attempt directory, returning relative POSIX paths.
- [ ] Implement the `device` capability fixture.
- [ ] Implement `AppError` → `DriverError` translation with abort/timeout
      propagation on every call.

### Verification

- [ ] Extend `tests/helpers/fake-driver.ts` or add a mobile fake so the existing
      driver-contract integration suite runs against a mobile-shaped manifest
      (no `web`, no `trace`, `state: false`).
- [ ] Unit-test locator evaluation, role normalization, snapshot projection, and
      error translation against recorded iOS and Android snapshot fixtures — no
      device required, and this is where most of the risk lives.
- [ ] Publish a mobile reference app plus a simulator/emulator conformance
      harness, and prove one portable test green against web, iOS, and Android
      (the PLAN.md Phase 5 exit criterion).
- [ ] Document mobile targets, the `device` fixture, and mobile capability gaps in
      `fern/`, including a driver-authoring page that currently does not exist.

## Resolved

- **Freeze now.** `mobile-0.1` is written and frozen as part of this work, per
  PLAN.md:120. No experimental flag, no back-filled spec.
- **Breaking changes allowed.** `packages/e2e` is unreleased, so
  `ResolvedTarget`, `DriverContext.app`, and the config schema change shape
  directly rather than growing compatibility layers.
- **Its own package**, `@e2edev/agent-device`, which owns the `agent-device`
  dependency; `e2e` carries no mobile peer.
- **Simulators and emulators only.** Physical devices are a later profile; many
  primitives the profile depends on (`clear-app-state`, `push`, `settings`,
  Face ID, clipboard) are simulator-only.
- **No Metro / RN dev-server integration.** `apps.open({runtime})` and
  `metro.reload` stay unused; no config surface for them.
- **`raw: true`** for every snapshot capture, so off-screen content is never
  collapsed into prose summaries.

## What real hardware changed

Running the suite against a real iOS simulator invalidated four assumptions that
every layer of unit testing had accepted. Each is now a spec change plus a fix.

1. **Backend visibility and hittability flags are unusable.** iOS omits
   `visibleToUser` entirely and reports `hittable: false` for plainly tappable
   controls whenever the simulator window is not frontmost. Verified by tapping
   a `hittable: false` cell and watching it navigate. Visibility and
   actionability now derive from geometry plus the backend's explicit occlusion
   signal; hittability is advisory.
2. **Refs have two spellings.** Snapshot JSON carries a bare `e12`; every
   interaction requires `@e12` and parses a bare ref as a selector. Normalized
   once at projection.
3. **iOS repeats a label up the ancestor chain.** A single Settings row put
   `General` on six nested nodes, so `getByText` matched six. Only the innermost
   carrier now owns a label for text and label queries, matching what web
   `getByText` resolves to.
4. **Launch must not open the app.** Resetting state by relaunching, then
   letting the attempt call `app.open`, started the app twice per test. Launch
   now resets without launching: 17 opens became 9 for the same 8 tests.

Two runner defects surfaced that are not mobile-specific, only mobile-visible:

- the direct-read surfaces encode "do not wait for a value" as an expired
  deadline, which reached the driver as a 1 ms I/O budget. Harmless against an
  in-process browser query, fatal against a 2.4 s XCTest snapshot.
- runtime provenance was read at launch, before any session could know device
  geometry, so a mobile report had no viewport. It is now read as the session
  closes, which also fixes `browserVersion` always being `unknown` for web.

Not yet addressed: `mobile-0.1` does not scroll implicitly before dispatching,
so an off-screen node is `NOT_ACTIONABLE` until a test scrolls it into view.
Web auto-scrolls as part of actionability, so this is a real portability seam.
Auto-scrolling the nearest scroll container is the obvious follow-up.

## Open Questions

Two normative table entries remain. Both are `spec/16-mobile.md` decisions that
directly affect whether a test can be portable across web and mobile.

1. **`placeholder` queries.** `SnapshotNode` exposes only `label`, `value`, and
   `identifier` — there is no placeholder field, even though iOS has
   `placeholderValue` natively. Options:
   (a) declare `getByPlaceholder` unsupported on `mobile-0.1` and throw
   `UNSUPPORTED_CAPABILITY`;
   (b) define it normatively as "the `label` of a node whose `value` is empty",
   which is where an iOS placeholder and an Android hint actually surface, and
   cover it with conformance vectors.
   Recommending **(b)**: `getByPlaceholder` is one of the most common ways to
   target a React Native `TextInput`, and (a) makes the single most obvious
   portable login test fail. (b) is only acceptable *because* it is written down
   and vector-tested rather than left as driver folklore.

2. **`checked` / `expanded` role states.** No first-class snapshot fields exist.
   Options: derive from per-platform conventions (iOS switch `value` of `"1"`/
   `"0"`, Android `checked`-bearing class roles), or declare both unsupported so
   an unsupported state on a role simply does not match — which
   `spec/08-platforms.md:75-77` already permits. Recommending **derive `checked`,
   declare `expanded` unsupported**: `checked` has a reliable convention on both
   platforms and drives switch/checkbox assertions; `expanded` does not, and
   guessing would produce silently wrong matches.
