# 09 - Driver SPI

The canonical `driver-1` contract is
[`api/driver.d.ts`](./api/driver.d.ts). Drivers are trusted executable packages
that map e2e-owned semantics onto an automation backend.

## Packaging and selection

`@e2edev/playwright` is the required reference driver for `web-0.1`, and
`@e2edev/agent-device` is the reference driver for `mobile-0.1`. Each ships
separately from the runner so that a project targeting one backend does not pay
for the other's toolchain. Community drivers use their own package names,
conventionally `e2e-driver-*`, and create instances with `defineDriver` from
`e2e/driver`.

```ts
import { defineDriver } from 'e2e/driver';

export const hyperdrive = () =>
  defineDriver({
    id: 'hyperdrive',
    version: '1.0.0',
    platforms: ['web'],
    spiVersion: 1,
    capabilities: {
      fixtures: ['web'],
      artifacts: ['screenshot', 'trace'],
      state: true,
    },
    async launch(context) {
      return createSession(context);
    },
  });
```

String IDs resolve only to the well-known driver names a runner documents. A
runner MAY satisfy such a name from a package it does not bundle, provided
resolution is deterministic and an uninstalled package is reported as a
configuration error rather than a launch failure; the reference runner resolves
`'playwright'` to `@e2edev/playwright`, loaded on demand. Every other driver is
an imported handle branded by `defineDriver`; metadata-only objects are not
accepted in target config. A multi-platform driver still requires an explicit
target platform. Driver `id` is stable across releases and contains
lowercase ASCII letters, numbers, `-`, `.`, or `/`.

Drivers declare platforms and capabilities synchronously. The runner validates
target and configured artifact requirements before collection. It validates
selected fixture/session requirements after collection and selection, when
their use is known, but before launch. A driver MUST NOT change its manifest
after launch.

## Trust boundary

An in-process driver has the same authority as test and config code: it can
read environment variables, repository files, browser state, and raw values it
is asked to type. `verifyDriver` is compatibility testing, not security
certification. Users MUST treat installed drivers as trusted dependencies.

A runner MAY support out-of-process sandboxed drivers, but that is not a v0
portability guarantee. Package provenance and sandbox claims are implementation
metadata, never inferred from conformance.

`driver-1` itself is an in-process TypeScript boundary. A backend using another
process supplies an in-process proxy that performs serialization, callback
delivery, cancellation, and teardown while preserving this contract.

## Lifecycle

A driver that needs slow one-time provisioning — downloading browsers, booting
a simulator, acquiring a device lease — implements the optional `prepare`
method. The runner calls `prepare` at most once per driver id per run, before
any session launches, passing every target in the run that resolves to that
driver. Provisioning belongs here precisely so it is never charged against
`config.launchTimeout`. `prepare` MUST be idempotent, MUST tolerate another
process provisioning the same resource concurrently, and MUST report progress
on stderr if at all, never stdout. A rejection aborts the run before any test
executes; a `DriverError` is translated by the usual mapping below, and any
other rejection becomes a non-retryable infrastructure `DRIVER_FAILURE`.
Drivers with nothing to provision omit `prepare`.

`launch` creates one logical test attempt or serial-group attempt. It receives
stable run, attempt, target, resolved app/query policy, artifact, deadline, and
cancellation context. Launch receives `config.launchTimeout`, independent of a
test/member timeout. `--headed` reaches every driver as immutable launch
options. If launch rejects,
the driver MUST roll back every partial acquisition before rejection because no
session exists for the runner to close. `close` receives a fresh cleanup signal
and budget independent of the cancelled attempt. It is idempotent and releases
every session-scoped resource: page, listener, temporary file, and device
lease.

Sessions of one driver instance are strictly serialized: the runner MUST NOT
invoke `launch` while a previously launched session of the same instance is
not yet closed. Drivers MUST NOT be assumed to support concurrent sessions;
a runner that executes tests in parallel acquires parallelism by creating one
driver instance per worker (one browser process or one device per worker),
never by overlapping sessions on a shared instance.

Within that serialized lifecycle a driver MAY keep expensive backend
resources alive between sessions — one browser process, one booted simulator
or emulator, one device lease — provided each new session observes a fully
isolated app state. Such drivers implement the optional `dispose` method. The
runner calls `dispose` at most once per driver instance, after every session
is closed, and never between attempts. `dispose` MUST be idempotent, MUST
release every retained resource, and MUST NOT affect previously captured
artifacts or state. Drivers without retained resources omit `dispose` and
release everything in `close`.

The runner calls `close` after pass, failure, timeout, cancellation, and signal.
A driver operation MUST observe both `AbortSignal` and `timeoutMs`. Aborted work
must stop before the promise settles. A driver that cannot stop an operation
must isolate it in a terminable child process and terminate that process.

No operation may continue mutating an app after it rejects or after `close`
resolves. Route/dialog decision methods and download waiters are bound to the
attempt signal and receive a current operation context for each decision.

`runtime()` supplies current viewport/scale and backend provenance. A
`web-0.1` session MUST return browser engine and exact version, and a
`mobile-0.1` session MUST return the resolved device name and OS version. The
runner reads it after launch to populate target provenance and after viewport
changes to record the operation's resulting runtime state. A target whose tests
were all filtered out never launches, so its provenance stays unresolved.

## Ownership boundary

| Concern | Owner |
|---|---|
| collection, targets, retries, hooks, sessions | runner |
| query polling and strict cardinality | runner |
| assertion polling | runner |
| one immediate query/read | driver |
| one node's actionability and input dispatch | driver |
| agent planning, prompts, budgets, ledger | runner |
| tool authorization and secret resolution | runner |
| backend process/page/device mechanics | driver |
| step/report/cache schemas | runner |
| source masking of secure observations | driver |
| defense-in-depth redaction | runner |

A driver MUST NOT add hidden query retries. Backend actionability waiting is
allowed only inside `perform` and only within the supplied operation budget.

## Locator expressions

The runner sends a complete immutable `LocatorExpression`, including scope,
filters, and index. `resolve` immediately returns all current matching
revision-bound node references. The driver does not enforce single-match
strictness.

`read` accepts only a current reference. `perform` executes exactly one action
against exactly one reference. A stale reference before dispatch is
`NODE_STALE` and retryable. If input may have reached the app, the driver MUST
throw `ACTION_MAY_HAVE_COMMITTED` with `retryable: false`; the runner will not
repeat it in that attempt.

The complete public action set maps to `LocatorAction`. Options such as
long-press duration, sensitive fill, swipe momentum, select index, drag
target, and input file paths MUST survive normalization unchanged. The runner resolves omitted
long-press duration to 500 ms before calling the driver.

The stale/commit contract applies to every mutator: locator actions, agent
actions, viewport swipes, app lifecycle, web navigation/input, route decisions,
and both nodes of a drag. Before dispatch, stale state is retryable. After any
input, navigation, or state mutation may have committed, failure is
`ACTION_MAY_HAVE_COMMITTED` and non-retryable. A driver MUST NOT report an
unknown commit state as retryable.

## Observation

`observe` atomically returns screenshot and semantic tree evidence for one
revision. References are unique within a session and valid only for that
revision. The root and every actionable node have stable geometry for the
captured viewport.

Pixel evidence is captured only when the runner asks for it. When it does, the
driver captures it within the same observation and under the same revision, as
close in time to the tree as its backend allows, and it MUST report:

- the true pixel dimensions of the image bytes it returns, measured rather than
  assumed. They are the coordinate space of everything read off the image, so a
  reported size that disagrees with the bytes displaces every coordinate;
- the scale relating those pixels to the CSS pixels of `SemanticNode.rect`,
  which is the space actions dispatch in;
- the number of regions it masked, in `redaction.maskedRegionCount`.

A capture that loses its document to a navigation in flight has dispatched
nothing and is repeatable: it is `NODE_STALE` and retryable, and the runner
re-observes the new document while the operation deadline remains. A capture
that ran out of budget is `OPERATION_TIMEOUT` and is not retried in place.

A driver that cannot capture pixels omits them rather than failing the
observation. A driver MAY implement point dispatch for the visual pointing tier;
without it, a runner-validated point cannot be acted on.

Secure fields have `states.secure: true`; their `value`, text, and sensitive
attributes are masked. `inputPurpose` is derived from standardized profile
rules. On web, password input type maps to `password`; autocomplete tokens
`username`, `current-password`/`new-password`, and `one-time-code` map to their
corresponding purposes; an explicitly registered secure custom field maps to
`generic-secret`; all others are `none`. Screenshot evidence is optional after
secret taint as defined in 14-security.md. `redaction.complete` is false if the
driver cannot prove required masking, and the runner then rejects the
observation without sending it to a model or persisting it.

Attributes are allowlisted by each execution profile. A web driver MUST omit
authorization data, cookies, inline script content, hidden form values, and
event-handler source.

Observations include iframe content. Each `<iframe>` appears as a boundary
node and its captured document nests beneath it; every node in an embedded
document carries `framePath`, the chain of runner-computed CSS selectors of
its enclosing iframe elements, outermost first. The runner uses `framePath`
to scope derived locators, so the model still only ever selects a node.
Frame capture is best-effort per frame and shares the observation node budget;
an unreadable frame leaves its boundary node childless.

## State capture

A driver declaring `state: true` implements `captureState` and `restoreState`.
Capture returns opaque JSON-safe `DriverState`; it never writes shared files.
The runner owns the `session-1` envelope, atomic persistence, target/app
validation, permissions, and cleanup.

Restore replaces all captured stores. It MUST NOT merge with the current
context. A driver that cannot faithfully capture every store required by its
profile cannot declare state capability. For `web-0.1`, required stores are
cookies, local storage, and IndexedDB.

## Web capability

The public `Web` object is a runner proxy. Drivers expose lower-level
`DriverWeb` operations that all receive operation context, allowing the runner
to apply deadlines, policy, step recording, path containment, and redaction.
Drivers MUST NOT return their backend page/context objects.

Public callback functions are trusted local code. The runner serializes
`evaluate` source and `JsonValue` arguments; remote/out-of-process drivers MUST
reject values outside that contract.

The runner executes route/dialog callbacks. It wraps driver event methods with
fresh operation contexts and never lets the driver invoke arbitrary test code
without runner accounting. Download waiting is two-phase: begin waiter, execute
the trigger in the runner, then finish or cancel the waiter.

## Artifacts

Screenshot is required by every driver profile. Trace and video are explicit
manifest capabilities. `web-0.1` requires screenshot, trace, and video; a driver
implementing only `core-0.1` may omit trace/video. Configuring an unsupported
artifact is a pre-run error.

Returned paths are relative POSIX paths beneath the provided attempt artifact
directory. Drivers canonicalize paths, reject traversal and symlink escape, and
finalize partial artifacts during `close`. Artifact recorder start/stop pairs
are idempotent under cancellation.

## Capability fixtures

Standard capabilities use standardized IDs and public types, and each has a
dedicated SPI member: `DriverWeb` for `web` and `DriverDevice` for `device`.
Like every other SPI surface these expose lower-level operations that receive an
operation context, so the runner keeps deadlines, cancellation, step recording,
and policy. The public `Web` and `Device` objects are runner proxies.

A third-party family instead returns runtime values in `capabilityFixtures`
under its namespaced ID and augments `TestFixtures` with the corresponding
property. A manifest entry without a runtime value, or a runtime value without a
manifest entry, is a driver error.

Capabilities do not bypass the universal SPI. Every platform still implements
`app`, `screen`, observation, actions, artifacts, cancellation, and cleanup.

## Errors

Drivers throw `DriverError` for expected backend conditions. `retryable` means
the exact operation is known not to have committed and may be attempted again
within the same deadline. Unknown exceptions become non-retryable
`DRIVER_FAILURE` and retain sanitized cause metadata.

Drivers never assign `AgentErrorCode`, test status, or process exit code. Those
are runner decisions.

Legal retryability is closed: `NODE_STALE` and `FRAME_NOT_FOUND` are true;
`FRAME_AMBIGUOUS`, `NOT_ACTIONABLE`, `ACTION_MAY_HAVE_COMMITTED`,
`OPERATION_TIMEOUT`, `CANCELLED`, `UNSUPPORTED_CAPABILITY`, `INVALID_STATE`, and
`DRIVER_FAILURE` are false. Any other combination is `DRIVER_FAILURE`. The
runner MUST retry stale node or missing frame resolution while the original
operation deadline remains; it MUST NOT retry another driver error in place.

## Conformance

`verifyDriver` is async and boots the versioned reference application. The
caller supplies a target factory; the verifier supplies its URL and fixtures.
It returns a machine-readable report rather than registering tests implicitly.

The `core-0.1` vectors cover:

- launch/close idempotence and cancellation;
- locator expression projection, cardinality inputs, and stale references;
- every locator and agent primitive, including option preservation;
- atomic observation and secure-field masking;
- state replacement and target isolation;
- artifact containment and cleanup;
- structured error behavior.

The `driver-1` vectors cover manifest branding/versioning, launch rollback,
operation/cleanup contexts, legal error combinations, capability consistency,
event bridges, and conformance-report artifact binding. `verifyDriver` emits a
separate `conformance-1` document for `driver-1`, `core-0.1`, and `web-0.1` when
all three are requested.

The `web-0.1` vectors additionally cover ARIA/name computation, text
normalization, actionability, navigation, routes, frames, cookies, dialogs,
downloads, evaluation, keyboard/mouse, trace, and video when declared.

Every vector has a stable requirement ID. Skipping a required vector fails that
profile. Implementations publish the conformance report generated against the
exact released driver artifact. The report uses `conformance-1`, includes the
driver package version and artifact digest, and requires evidence references for
every failed vector.

Consumers verify a driver claim by running `verifyDriver` themselves against
the digest-pinned artifact in a trusted environment. The verifier does not
accept a package-provided report as proof.

## SPI compatibility

`spiVersion: 1` is exact. A runner rejects another major version before launch.
Additive optional members do not change the major version; changing required
semantics does. The test-facing SDK and driver SPI version independently as
defined in 00-conformance.md.
