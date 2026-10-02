# @e2e-dev/mobile

The mobile engine for [`e2e`](https://www.npmjs.com/package/e2e), built on
[agent-device](https://github.com/callstack/agent-device): iOS simulators,
Android emulators, and connected phones through the same `e2e/engine` contract the browser engine
implements. A test written against `screen`, `expect`, `app`, and `agent` runs
on a device target unchanged; nothing in `e2e` core knows this package exists.

## Install

Run `npx e2e init` and choose **Mobile (iOS/Android)** for a Settings
example with optional AI testing. Init defaults to iOS on macOS and Android
elsewhere; change the platform in `e2e.config.ts` when needed.
Or add the packages to an existing project:

```bash
npm install --save-dev e2e @e2e-dev/mobile
```

`agent-device` needs Xcode with an iOS simulator runtime, or the Android SDK
with an emulator. A phone needs Developer Mode and runner signing on iOS, or
USB debugging authorized on Android (see [Physical devices](https://e2e.tester.army/docs/physical-devices)). Run `npx agent-device doctor` once before handing the target
to the runner.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { mobileTools } from '@e2e-dev/mobile/tools';
import { gateway } from 'ai';

const iphone = mobile({ platform: 'ios' });
const pixel = mobile({ platform: 'android' });

export default {
  targets: [
    { name: 'iphone', engine: iphone, app: { bundleId: 'Settings' } },
    { name: 'pixel', engine: pixel, app: { bundleId: 'com.android.settings' } },
  ],
  workers: 1,
  agents: {
    default: {
      model: gateway('openai/gpt-5.6-luna'),
      tools: mobileTools(iphone, pixel),
    },
  },
} satisfies E2EConfig;
```

A test written against `agent`, `app`, `screen`, and `device` runs on both
targets unchanged. Only a check that names a platform label (`General` on iOS,
`Network & internet` on Android) needs `platforms: ['ios']` or
`platforms: ['android']` on the test.

The app under test is the target's `app`; the engine only drives it. A
device target needs `bundleId` or `appPath`:

| Key | Meaning |
| --- | --- |
| `bundleId` | Bundle id, package, or display name `app.open()`, `app.restart()`, and `app.clearState()` launch fresh; an attempt launches nothing on its own. |
| `appPath` | An iOS `.app` bundle or Android `.apk`, resolved against the project root. The engine does not install it: the suite calls `device.installApp()` (with no path, this build) once per device, unless a device provider already installed it. Without `bundleId`, the installed bundle id or package is the app `app.open()` launches. |
| `launchArguments` | Arguments every fresh launch of the pinned app carries (`app.open()`, `app.restart()`, `app.clearState()`): the process arguments on iOS, `am start` arguments on Android. The warm-up passes none. |
| `permissions` | Permissions the pinned app holds on every fresh launch, `{ camera: 'grant', location: 'deny', notifications: 'reset' }`, set before the app starts and put back after `app.clearState()` reset them. |

`app.url` is not supported on a device target yet, and `mobile({ app })` and
the other old app options are `INVALID_CONFIG` naming their key under `app`.

`mobile()` options:

| Option | Meaning |
| --- | --- |
| `platform` | `'ios'` or `'android'`. |
| `device` | Simulator or emulator name or UDID, or a connected phone's name. A list is a pool: one worker per entry, worker slot `n` driving the `n`th. Omitted, every booted device of the platform is the pool, as many as the run has slots. |
| `session` | agent-device session name, before the worker slot: slot `n` drives its device under `<session>-<n>`, `e2e-<target name>-<n>` by default. One run per session at a time. |
| `snapshot` | `'full'` (default, includes static text) or `'interactive'` (actionable nodes only). |
| `settle` | For agent actions: milliseconds the UI must hold still after an action before the agent observes again, default `150`; `false` skips the wait. A test's own steps never settle; `expect` verifies their outcome. |
| `transition` | For a test's steps: milliseconds a control that appeared or moved with the last action gets to finish arriving before it is acted on, default `500`. Controls already in place before the action are acted on at once. |

Every optional `mobile()` value also accepts `undefined`, so a config passes
`device: process.env.E2E_DEVICE` straight through, with no conditional
spread.

## What the engine declares

- **Observation**: the accessibility tree, projected onto the role vocabulary
  (iOS `Button` becomes `button`, `TextField` becomes `textbox`, `Cell` becomes
  `listitem`; Android `android.widget.TextView` becomes `text`, `EditText`
  becomes `textbox`, `Switch` becomes `switch`), with rects, a viewport, and
  pixels on request with every secure field painted over. Element identifiers
  (`ABOUT`, `android:id/title`) are the node's `testId`, what `getByTestId`
  matches.
- **Actions**: tap, double tap, long press, fill, clear, check/uncheck (when
  the tree exposes the checked state; Android switches do not), focus on
  editable fields, `Enter`, single-character keys, swipe within a node, drag.
  `selectOption`, `setInputFiles`, `scrollIntoView`, `secondaryTap`,
  `modifiers` on `tap` or `doubleTap`, focus on a control, and other keys fail with
  `UNSUPPORTED_CAPABILITY`.
- **Location**: every `screen` query, plus agent-device selectors through
  `device.locator('role=NavigationBar id=General')`.
- **Viewport swipe**, `app.back()`, `app.restart()`, `app.clearState()`, and
  redacted screenshots under the attempt artifact directory: the bounds of
  every secure field are painted black before the file is kept, and a
  screenshot that cannot be redacted is not written. No `state` capability: a
  simulator has no portable session snapshot.
- **App kind**: a target with `app.bundleId` or `app.appPath` is a `native-app` target, so a portable suite can `requires: ['native-app']`.

## Replay cache

The runner caches `agent.act` steps by their location anchor, and a device has
no address bar. This engine reports one anyway: `<bundle id> / <screen
title>`, with the title read off the navigation bar on iOS and the collapsing
toolbar on Android. The app identity is part of the location, so two apps with
a "General" screen never share an anchor. A step recorded on
`com.apple.Preferences / General` replays only when that app is on that
screen again, and a flow that stays within tap, type, and scroll replays with
zero model calls. Declare `app.bundleId` and call `app.open()` first, so steps start on
the same screen, and
prefer the grammar over the `open_app` tool inside a step: a tool call is a
replay gap.

## The `device` fixture

Deterministic device management, recorded as `device.<method>` steps. Import
`test` from this package to have it typed.

```ts
import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('shows the version offline in dark mode', async ({ agent, device, screen }) => {
  await device.setAppearance('dark');
  await device.setNetwork('offline');
  await agent.act('go to General, then About');
  await expect(screen.getByRole('button', /^iOS Version/)).toBeVisible();
  await expect(device.locator('role=NavigationBar id=About')).toBeVisible();
});
```

Methods: `setNetwork`, `setAirplaneMode`, `setPermission`, `setLocation`,
`clearLocation`, `setAppearance`, `setOrientation`, `fold`, `setBiometrics`,
`enrollBiometrics`, `installApp`, `openApp`, `closeApp`, `clearKeychain`,
`foregroundApp`, `home`, `back`, `alert`, `dismissKeyboard`, `clipboard`,
`setClipboard`, and the `locator` accessor.

`installApp(appPath, { app, reinstall })` puts a build on the device from a
test, for upgrade and fresh-install paths the target's `app.appPath` cannot
express.
A plain install replaces the binary and keeps its data; `reinstall: true`
removes the app named by `app` (default: the pinned app) first. It resolves to
the bundle id or package to `openApp` the build by. `openApp` takes an app id,
never a link; `openLink` opens one, under the navigation rule.

## Agent tools

`@e2e-dev/mobile/tools` exports `mobileTools(...engines)`: `open_app`,
`swipe` (free-form, in logical pixels), and `alert` (accept or dismiss a
system alert). It takes at least one engine. Pass every device engine the
config declares: tool names are fixed, so two packs cannot be merged, and the
pack dispatches each call to the engine whose attempt is running. Tools are
scoped to the platforms of those engines, so a suite that mixes web and device
targets can hand the pack to one agents entry's `tools`.

## Secrets

`type_secret` and `screen.getByLabel(...).fill(secret)` fill declared secrets
on a device: a credential's password into a secure field, a `secrets` entry
into any editable input. The model never sees the value, and screenshots are
withheld for the rest of the attempt.

## Documentation

Full documentation lives at [e2e.tester.army/docs](https://e2e.tester.army/docs).
