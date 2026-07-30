# 16 - Mobile Execution

`mobile-0.1` defines iOS and Android execution. The canonical source API is
[`api/e2e.d.ts`](./api/e2e.d.ts); the normalized backend contract is
[`api/driver.d.ts`](./api/driver.d.ts). This document is normative.

`mobile-0.1` is a sibling of `web-0.1`. Both build on `core-0.1` and `driver-1`,
and a driver MAY implement either or both. Nothing here changes `web-0.1`.

## Device scope

`mobile-0.1` covers iOS simulators and Android emulators only. A driver MUST
reject a physical-device target with `UNSUPPORTED_CAPABILITY` rather than
degrading, because required primitives of this profile — application data
reset, push injection, permission control, and biometric simulation — are not
available on physical devices across both platforms. Physical devices require a
separate profile.

A driver MUST NOT erase a device, reset system settings it did not set, remove
apps it did not install, or modify user data outside the target application's
container. Device-destructive operations are outside this profile.

## Targets and application identity

```ts
import { agentDevice } from '@e2edev/agent-device';

export default defineConfig({
  targets: [
    { name: 'ios', platform: 'ios', driver: agentDevice(), app: 'com.example.app' },
    { name: 'android', platform: 'android', driver: agentDevice(), app: './android/app.apk' },
  ],
});
```

`MobileTarget.app` is REQUIRED and is either:

- an **installed application identity** — an iOS bundle identifier or an Android
  package name; the driver MUST fail launch with `INVALID_STATE` when it is not
  installed on the selected device; or
- a **build artifact path** — `.app` or `.ipa` on iOS, `.apk` or `.aab` on
  Android, resolved against the project root. The driver installs it and derives
  the application identity from the artifact. It MUST NOT infer identity from the
  filename.

`device` selects the simulator or emulator by name and `os` selects its OS
version. Omitting either lets the driver select any available matching device. A
session MUST report the device name and OS version it resolved from `runtime()`,
which the runner records as target provenance. A mobile target has no configured
viewport; its viewport is a property of the resolved device and is likewise read
from `runtime()`.

Mobile targets have no browser, no viewport configuration, and no base URL.
`app.baseUrl` is not required by this profile, and `DriverContext.app.baseUrl` is
absent for a mobile target.

## Accessibility projection

The driver projects the platform accessibility tree onto `SemanticNode`. The
projection is the profile's portability surface, so it is fully specified here.

A projection MUST:

- preserve platform tree order as document order, so `first`, `last`, `nth`, and
  ordering vectors are stable;
- include every node the platform exposes to assistive technology, including
  nodes currently scrolled out of the viewport. A driver MUST NOT omit,
  summarize, or collapse off-screen content, because `count`,
  `scrollUntilVisible`, and `scrollTo` depend on its presence;
- bind every node to the observation revision it was captured in. A reference
  used after its revision is superseded is `NODE_STALE` and retryable.

`rect` is in device-independent points, the same space actions dispatch in. A
node without geometry omits `rect`; it is never zero-filled.

Geometry MUST be validated against the tree before it is trusted. A rect
encloses area, and a node's rect intersects the bounds its ancestors impose. A
scroll container imposes no bounds on its children, because a row scrolled below
the fold is genuinely outside its container's frame while still being real; every
other view does, because its subviews lie inside it. Geometry failing this check
counts as absent.

This is not defensive coding. iOS reports stale geometry for the descendants of
a row scrolled out of the viewport, placing them where the row used to be and
zeroing the innermost ones. Trusting that reports an unreachable node as
reachable, and hands the row's label to a node that can be neither seen nor
tapped, which makes the row unmatchable.

There is no frame concept on mobile. `framePath` is always absent, and the
`frame` and `web-selector` locator-expression kinds MUST be rejected with
`UNSUPPORTED_CAPABILITY`.

## Role normalization

`getByRole` uses WAI-ARIA 1.2 role names on every platform. A driver MUST map the
platform role, subrole, or native element type — in that precedence order, first
match wins — through the tables below. An element type absent from its platform's
table normalizes to `generic`.

Role-based targeting of static text is NOT portable to web, where the same text
usually computes to `generic`. `getByText` is the portable way to target text.

### iOS

| Platform element type | Role |
|---|---|
| `Button`, `Key` | `button` |
| `Link` | `link` |
| `StaticText`, non-editable `TextView` | `paragraph` |
| `TextField`, editable `TextView` | `textbox` |
| `SecureTextField` | `textbox`, `states.secure: true` |
| `SearchField` | `searchbox` |
| `CheckBox` | `checkbox` |
| `RadioButton` | `radio` |
| `Switch` | `switch` |
| `Slider` | `slider` |
| `Stepper` | `spinbutton` |
| `Image` | `img` |
| `Cell` | `listitem` |
| `Table`, `CollectionView` | `list` |
| `NavigationBar` | `navigation` |
| `TabBar`, `SegmentedControl` | `tablist` |
| `Tab` | `tab` |
| `Alert`, `Sheet` | `alertdialog` |
| `ActivityIndicator`, `ProgressIndicator` | `progressbar` |
| `Toolbar` | `toolbar` |
| `Picker`, `PickerWheel` | `combobox` |
| `Menu` | `menu` |
| `MenuItem` | `menuitem` |
| `StatusBar` | `banner` |
| `WebView` | `document` |
| `Application` | `application` |
| `Window`, `Other`, `Keyboard` | `generic` |

### Android

| Platform class or semantic role | Role |
|---|---|
| `Button`, `ImageButton`, Compose `Button` | `button` |
| `TextView`, `CheckedTextView` without a checkable state | `paragraph` |
| `EditText` | `textbox` |
| `EditText` with a search input type, `SearchView` | `searchbox` |
| `CheckBox`, `CheckedTextView` with a checkable state, Compose `Checkbox` | `checkbox` |
| `RadioButton`, Compose `RadioButton` | `radio` |
| `Switch`, `SwitchCompat`, `ToggleButton`, Compose `Switch` | `switch` |
| `SeekBar`, `RatingBar` | `slider` |
| `ProgressBar` | `progressbar` |
| `ImageView`, Compose `Image` | `img` |
| `RecyclerView`, `ListView`, `GridView` | `list` |
| direct child of a `list` role | `listitem` |
| `Spinner`, Compose `DropdownList` | `combobox` |
| `TabWidget`, `TabLayout` | `tablist` |
| `TabView`, Compose `Tab` | `tab` |
| `Toolbar`, `ActionBar` | `toolbar` |
| `AlertDialog` root | `alertdialog` |
| `WebView` | `document` |
| any other `View` or `ViewGroup` | `generic` |

A node whose native type is `ScrollView`, `HorizontalScrollView`,
`NestedScrollView`, `RecyclerView`, `ListView`, `GridView`, `Table`,
`CollectionView`, or iOS `ScrollView` is a **scroll container**.
`screen.scrollUntilVisible` scrolls the nearest scroll-container ancestor of the
target; with none, it scrolls the viewport.

## Query mapping

| Query | Mobile source |
|---|---|
| `role` | the normalized role |
| `label` | the accessibility label |
| `text` | the accessibility label, else the value |
| `displayValue` | the accessibility value |
| `testId` | the accessibility identifier |
| `placeholder` | the label of a `textbox` or `searchbox` whose value is empty or absent |

A platform may copy one element's label onto the nodes nested inside it: iOS
repeats a row's accessibility label on every wrapper down to its innermost text.
A repeated label belongs to its **outermost** carrier, which is the element the
user sees and taps; the copies are that one control's internals, not separate
targets. A node carrying a label it does not own matches no label or text query,
and an observation MUST omit it, because a model can only select nodes a derived
query can address.

`testId` maps to the iOS accessibility identifier and the Android view
resource-id or Compose test tag. React Native's `testID` sets exactly these.
`screen.testIdAttribute` is a web-only setting and MUST be ignored.

The `placeholder` mapping reflects how both platforms expose placeholder and hint
text: an unfilled field's prompt is its accessibility label, and it stops being
the label once the field holds a value. A driver MUST NOT match `placeholder`
against a field that has a value.

Text normalization and exact/regexp behavior follow 03-assertions.md, identically
to `web-0.1`.

### Role states

| State | Mobile source |
|---|---|
| `disabled` | the node is not enabled |
| `selected` | the node is selected |
| `focused` | the node is focused |
| `hidden` | the node is not visible to the user |
| `checked` | derived; see below |
| `expanded` | not supported |

`checked` is derived only for a node whose normalized role is `checkbox`,
`radio`, or `switch`. The value `1`, `true`, or `checked` is checked; `0`,
`false`, or `unchecked` is unchecked; with no value, the selected state is used.
Any other value leaves the state unavailable.

State availability is platform-dependent, and a driver MUST leave an
unobservable state unavailable rather than reporting it as false. A backend may
expose a switch as a node carrying no value, selected state, or label at all, in
which case `checked` cannot be derived for it. A test that needs the state on
such a platform must read it from whatever the app itself exposes, for example a
row label that spells the state out.

An unsupported state on a role does not match, per 08-platforms.md. `expanded`
therefore never matches on mobile; neither does `checked` on a role outside that
set. A driver MUST NOT guess an unavailable state.

## Cardinality

Cardinality, ordering, scope, filters, and index behavior are exactly as
08-platforms.md defines them. A scoped query examines descendants and excludes
the scope node. The runner owns polling and strictness; `resolve` and `read` are
immediate.

## Visibility and actionability

Mobile accessibility backends do not reliably expose a visibility or
hit-testability flag. On iOS, XCUITest omits a visibility flag entirely, and its
`isHittable` is false for plainly tappable controls whenever the simulator
window is not frontmost. A profile that gated on those flags would be unusable,
so visibility and actionability are computed from geometry and from explicit
occlusion, and any backend hittability flag is advisory only.

A node is **visible** when the backend has not reported it hidden and it has
geometry with positive area. Scroll position does not affect visibility, which
matches `web-0.1`, where an element below the fold is still visible.

A node is **actionable** when it is visible, enabled if its role supports the
state, not reported as occluded by another element, and its action point — the
center of its rect — lies within the device viewport. `fill` additionally
requires an editable control.

The driver MUST NOT retarget. If a resolved node is not itself actionable, the
action fails `NOT_ACTIONABLE`; substituting an ancestor or a nearby node would
silently violate the node the test selected.

Choosing where inside a node to dispatch is not retargeting. A platform may
expose one control as nested nodes that share a role: iOS wraps a switch in a
same-role container spanning the whole row, and that container's center lies on
the row label, where input has no effect. The action point is therefore the
center of the innermost descendant that shares the node's role and covers less
area, and the node's own center when it has no such descendant. Without this
rule an action on a correctly resolved control is a silent no-op, which is worse
than a failure.

A node scrolled outside the viewport is visible but not yet actionable, and
carries `states.offscreen`, so a test, an assertion, and a model can all tell
"not rendered" apart from "not reachable yet". A `mobile-0.1` driver MUST NOT
scroll implicitly before dispatching: a scroll is a physical gesture that
invalidates every node reference, and a driver that scrolled and then re-found
its target would be retargeting.

The runner scrolls instead. A located action against an offscreen node scrolls
it into view and retries, within the action's own deadline, which is the runner
exercising the waiting and retry duties 01-principles.md already assigns it. The
observable result is that a portable action behaves the same here as under
`web-0.1`, where the backend scrolls as part of actionability: the same test
passes on both, and `01-principles.md` does not permit a backend to change what
a portable test does. Only the layer that performs the scroll differs, which is
not something a test can observe.

`states.offscreen` remains observable for tests that want to assert on
reachability, and `screen.scrollUntilVisible` remains the explicit loop for
waiting on it.

`scrollIntoView` performs one gesture toward the target, in the target's nearest
scroll container when it has one. A single gesture need not reach a distant
target; `screen.scrollUntilVisible` is the loop, and it re-resolves the target
each round because a scroll invalidates every node reference.

`agent.scrollTo` owns the same loop, and for the same reason it is easy to miss:
the observation carries nodes far below the fold, so a model locates the target
on the first judgment without the runner having scrolled at all, and one gesture
then lands short of a target thousands of points away. A runner MUST NOT report
`scrollTo` complete while its target still carries `states.offscreen`.

The stale/commit contract of 09-drivers.md applies unchanged: stale before
dispatch is retryable `NODE_STALE`, and once input may have reached the
application the failure is `ACTION_MAY_HAVE_COMMITTED` with `retryable: false`.

## Scrolling

Scroll direction is from the user's perspective, and momentum distances are
exactly as 08-platforms.md defines them: `none` moves 50% of the active
scrollport, `slow` 75%, and `fast` 150%, capped by the remaining scroll range.
Locator swipes start at 75% and end at 25% of the relevant axis.

Momentum duration is advisory for a scrollport scroll. Distance is what reaches
content, and a mobile backend may own the gesture's timing; a driver MUST
preserve the distance and MUST NOT trade a correct distance for a requested
duration.

## Settling

A mobile transition animates for a few hundred milliseconds. A driver MUST wait
for the UI to go quiet after a mutation, before the next observation can be
taken.

This is not a convenience. Assertions poll and would recover on their own, but a
direct read does not: a read taken during a push transition returns the previous
screen and reports success, which is a false pass. `web-0.1` gets the same
guarantee from actionability's stability requirement, which has no mobile
equivalent because a mobile backend does not expose animation frames.

## `app` in the mobile profile

- `open()` launches the application, replacing any running instance, and waits
  for it to become foreground. `open(path)` launches it and then opens `path` as
  a deep link.
- `restart()` terminates and relaunches the application, preserving its data
  container.
- `clearState()` clears the application data container, then relaunches. It MUST
  NOT clear another application's data or any system setting. An application
  with no data container, such as a built-in system application, cannot be
  reset; the driver MUST report that rather than reporting a successful reset
  that did nothing. A target whose application cannot be reset does not get
  per-attempt state isolation, and a driver MUST require that to be configured
  explicitly rather than degrading silently.
- `back()` performs one application-owned back navigation: visible in-app back
  affordance on iOS, the platform back event on Android. No back target is a
  successful no-op.
- `deepLink(url)` opens `url` on the device. An `http` or `https` URL MUST pass
  the same origin policy as web navigation. A custom-scheme URL is allowed
  without origin checking because it cannot leave the device. Every URL MUST
  still be absolute and MUST NOT use `file:`, `data:`, or `javascript:`, which
  are denied on every platform.
- `screenshot()` returns an artifact-root-relative POSIX path, subject to the
  redaction rule below.

Launch starts with the application not yet foreground. UI operations before
`app.open` fail with `APP_NOT_OPEN`.

## `device`

`mobile-0.1` requires the `device` capability. Tests using it SHOULD declare
`requires: ['device']`. The public `Device` object is a runner proxy over
`DriverDevice`, so every operation is deadline-bounded and step-recorded.

`home` sends the device to its home screen. `hideKeyboard` dismisses the
software keyboard and is a successful no-op when no keyboard is shown.
`openUrl` follows `app.deepLink` policy. `setLocation` sets the simulated
location. `setPermission` sets one permission for the target application only;
`unset` restores the platform default rather than denying. `pushNotification`
delivers one simulated notification to the target application.

A permission or notification operation MUST be scoped to the target
application. `setPermission` on a permission the platform does not expose is
`UNSUPPORTED_CAPABILITY`.

## Observation and redaction

`observe` returns one atomic revision, per 09-drivers.md. Secure fields have
`states.secure: true`, and their value, text, and sensitive attributes are
masked at the source.

`inputPurpose` derives from platform signals: an iOS secure text field and an
Android password input type map to `password`; an explicitly registered secure
custom field maps to `generic-secret`; a field whose content type declares a
one-time code maps to `one-time-code`; a username content type maps to
`username`; all others are `none`.

Pixel evidence has no platform masking primitive on mobile. A driver that cannot
mask a secure region MUST omit `pixels` from the observation whenever the
captured revision contains a visible secure node, rather than returning
unmasked pixels or `redaction.complete: false`. Omission degrades the vision
tier; the alternatives leak a secret or force the runner to discard the
observation. When pixels are returned, the driver MUST report the true measured
dimensions of the image bytes and the scale relating them to `rect` points.

`app.screenshot()` follows the same rule and rejects with `POLICY_DENIED` when a
visible secure node would appear unmasked.

Attributes are allowlisted. A mobile driver MUST omit authorization data,
credential values, and any attribute carrying the contents of a secure field.

## Locate cache

`cache-1` applies unchanged, but two of its inputs behave differently here and
both are load-bearing.

A mobile session exposes no URL, so it contributes no route (10-determinism.md)
and the starting route fingerprint reduces to the viewport alone. The viewport
is therefore the only part of the key that describes *where* the session is, and
on a device it does not vary between screens. A cached locate is separated from
another by the test, the instruction, its parameters, and its occurrence index —
never by the screen. That is safe for the reason any route collision is safe: an
entry is re-resolved and its role and name re-verified against the live node
before the action runs, so the worst case is a miss. It does mean a conditional
screen, which mobile has more of than the web, shifts occurrence indexes and
costs hits.

Because the viewport carries that weight, a driver MUST report a stable viewport
for the life of a session: the value it reports for one revision is the value it
reports for every later revision. `observation.viewport` is in point space, the
space `rect` coordinates and dispatched actions use, so its scale is `1`. Device
pixel density describes the captured image, not the geometry, and is reported on
`pixels.scale`. A driver that adopts a measured density into the viewport when
it first captures pixels re-keys every later call of that session, and only on
the runs that captured pixels, which fills the store with entries no run can
read.

App identity for a cache key is the declared environment alone
(10-determinism.md), so it does not include `MobileTarget.app`. Repointing one
target name at a different build or bundle identifier therefore does not
invalidate its entries. Give genuinely different applications different target
names.

## State

`mobile-0.1` does not define application state capture. A `mobile-0.1` driver
declares `state: false` and omits `captureState` and `restoreState`, so
`test.setup` and session reuse fail `UNSUPPORTED_CAPABILITY` on mobile targets.
`app.clearState()` remains available for per-test reset.

A future profile revision MAY define state capture. Until it does, a driver MUST
NOT declare `state: true` for a mobile target on the basis of a partial
container copy, per 09-drivers.md.

## Artifacts

`mobile-0.1` requires `screenshot` and `video`. It does not define `trace`,
which has no portable iOS and Android equivalent; configuring it is a pre-run
`UNSUPPORTED_ARTIFACT` error. Containment, canonicalization, and finalization
rules are unchanged from 09-drivers.md.

## Capability boundary

A `mobile-0.1` driver does not implement `DriverWeb`. The `web` fixture is
absent, and a test requiring it is skipped as capability-unavailable rather than
failing.

## Conformance

The `mobile-0.1` vectors cover:

- device-scope rejection of physical devices and destructive operations;
- application identity from both installed identity and build artifact;
- accessibility projection ordering, off-screen inclusion, and revision binding;
- every role normalization table entry on both platforms;
- every query mapping, including the placeholder value rule;
- `checked` derivation and non-matching of unsupported states;
- actionability without retargeting, and the precommit/committed boundary;
- scroll momentum distances and scroll-container selection;
- `app` lifecycle, data-container reset scope, and deep-link origin policy;
- every `device` operation and its application scoping;
- secure-field masking, `inputPurpose` derivation, and pixel omission;
- absence of state capability, `trace`, `web`, and frames;
- artifact containment and finalization.

Every vector has a stable requirement ID in
[`conformance/v0-requirements.json`](./conformance/v0-requirements.json). A
driver claiming `mobile-0.1` runs them on both an iOS simulator and an Android
emulator; a single-platform result does not satisfy the profile.
