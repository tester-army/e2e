# @e2edev/agent-device

The mobile engine for [`@e2edev/e2e`](https://www.npmjs.com/package/@e2edev/e2e), built on
[agent-device](https://github.com/callstack/agent-device): iOS simulators and
Android emulators through the same `@e2edev/e2e/engine` contract the browser engine
implements. A test written against `screen`, `expect`, `app`, and `agent` runs
on a device target unchanged; nothing in `e2e` core knows this package exists.

## Install

Run `npx @e2edev/e2e init` and choose **agent-device** for a Settings
example with optional AI testing. Init defaults to iOS on macOS and Android
elsewhere; change the platform in `e2e.config.ts` when needed.
Or add the packages to an existing project:

```bash
npm install --save-dev @e2edev/e2e @e2edev/agent-device
```

`agent-device` needs Xcode with an iOS simulator runtime, or the Android SDK
with an emulator. Run `npx agent-device doctor` once before handing the target
to the runner.

```ts title="e2e.config.ts"
import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';

const iphone = agentDevice({ platform: 'ios', app: 'Settings' });
const pixel = agentDevice({ platform: 'android', app: 'com.android.settings' });

export default {
  targets: [
    { name: 'iphone', engine: iphone },
    { name: 'pixel', engine: pixel },
  ],
  workers: 1,
  agents: { default: { executor: createAgent({ tools: agentDeviceTools(iphone, pixel) }) } },
} satisfies E2EConfig;
```

A test written against `agent`, `app`, `screen`, and `device` runs on both
targets unchanged. Only a check that names a platform label (`General` on iOS,
`Network & internet` on Android) needs `platforms: ['ios']` or
`platforms: ['android']` on the test.

Options:

| Option | Meaning |
| --- | --- |
| `platform` | `'ios'` or `'android'`. |
| `app` | Bundle id, package, or display name opened fresh at the start of every attempt. Also unlocks `app.restart()` and `app.clearState()`. |
| `appPath` | An iOS `.app` bundle or Android `.apk` installed once per worker before the first attempt, resolved against the project root. Without `app`, the installed bundle id or package is the app opened per attempt. |
| `device` | Simulator or emulator name or UDID. A list is a pool: one worker per entry, worker slot `n` driving the `n`th. Omitted, every booted device of the platform is the pool, as many as the run has slots. |
| `session` | agent-device session name, before the worker slot: slot `n` drives its device under `<session>-<n>`, `e2e-<target name>-<n>` by default. One run per session at a time. |
| `snapshot` | `'full'` (default, includes static text) or `'interactive'` (actionable nodes only). |
| `settle` | For agent actions: milliseconds the UI must hold still after an action before the agent observes again, default `150`; `false` skips the wait. A test's own steps never settle; `expect` verifies their outcome. |
| `transition` | For a test's steps: milliseconds a control that appeared or moved with the last action gets to finish arriving before it is acted on, default `500`. Controls already in place before the action are acted on at once. |

Every optional value also accepts `undefined`, so a config passes
`device: process.env.E2E_DEVICE` or `appPath: process.env.E2E_APP_PATH`
straight through, with no conditional spread.

## What the engine declares

- **Observation**: the accessibility tree, projected onto the role vocabulary
  (iOS `Button` becomes `button`, `TextField` becomes `textbox`, `Cell` becomes
  `listitem`; Android `android.widget.TextView` becomes `text`, `EditText`
  becomes `textbox`, `Switch` becomes `switch`), with rects, a viewport, and
  pixels on request with every secure field painted over. Element identifiers
  (`ABOUT`, `android:id/title`) surface as the configured test id attribute.
- **Actions**: tap, double tap, long press, fill, clear, check/uncheck (when
  the tree exposes the checked state; Android switches do not), focus on
  editable fields, `Enter`, single-character keys, swipe within a node, drag.
  `selectOption`, `setInputFiles`, focus on a control, and other keys fail
  with `UNSUPPORTED_CAPABILITY`.
- **Location**: every `screen` query, plus agent-device selectors through
  `device.locator('role=NavigationBar id=General')`.
- **Viewport swipe**, `app.back()`, `app.restart()`, `app.clearState()`, and
  redacted screenshots under the attempt artifact directory: the bounds of
  every secure field are painted black before the file is kept, and a
  screenshot that cannot be redacted is not written. No `state` capability: a
  simulator has no portable session snapshot.

## Trace cache

The runner caches `agent.act` steps by their location anchor, and a device has
no address bar. This engine reports one anyway: `<bundle id> / <screen
title>`, with the title read off the navigation bar on iOS and the collapsing
toolbar on Android. The app identity is part of the location, so two apps with
a "General" screen never share an anchor. A step recorded on
`com.apple.Preferences / General` replays only when that app is on that
screen again, and a flow that stays within tap, type, and scroll replays with
zero model calls. Pin `app` so every attempt starts on the same screen, and
prefer the grammar over the `open_app` tool inside a step: a tool call is a
replay gap.

## The `device` fixture

Deterministic device management, recorded as `device.<method>` steps. Import
`test` from this package to have it typed.

```ts
import { test } from '@e2edev/agent-device';
import { expect } from '@e2edev/e2e';

test('shows the version offline in dark mode', async ({ agent, device, screen }) => {
  await device.setAppearance('dark');
  await device.setNetwork('offline');
  await agent.act('go to General, then About');
  await expect(screen.getByRole('button', { name: /^iOS Version/ })).toBeVisible();
  await expect(device.locator('role=NavigationBar id=About')).toBeVisible();
});
```

Methods: `setNetwork`, `setAirplaneMode`, `setPermission`, `setLocation`,
`clearLocation`, `setAppearance`, `setOrientation`, `setBiometrics`,
`enrollBiometrics`, `installApp`, `openApp`, `closeApp`, `foregroundApp`,
`home`, `back`, `alert`, `dismissKeyboard`, `clipboard`, `setClipboard`, and
the `locator` accessor.

`installApp(appPath, { app, reinstall })` puts a build on the device from a
test, for upgrade and fresh-install paths the `appPath` option cannot express.
A plain install replaces the binary and keeps its data; `reinstall: true`
removes the app named by `app` (default: the pinned app) first. It resolves to
the bundle id or package to `openApp` the build by.

## Agent tools

`@e2edev/agent-device/tools` exports `agentDeviceTools(...engines)`:
`open_app`, `swipe` (free-form, in logical pixels), `type_text` (into the
focused field, for editors that hide it from the tree), `alert`, and
`screenshot` (the model sees the image). Pass every device engine the config
declares: tool names are fixed, so two packs cannot be merged, and the pack
dispatches each call to the engine whose attempt is running. Tools are scoped
to the platforms of those engines, so a suite that mixes web and device
targets can hand the pack to one `createAgent`.

## Secrets

Secret fills need an origin the runner can check, and a device location is
not a URL, so it has no origin an allowlist can name: `type_secret` is denied
on a device target before any plaintext reaches the device. Fill credentials
through a deterministic `screen` action in a setup step instead.

## Documentation

Full documentation lives at [e2e.mintlify.app](https://e2e.mintlify.app).
