# @e2edev/agent-device

The mobile backend for [`e2e`](https://www.npmjs.com/package/e2e), built on
[agent-device](https://github.com/callstack/agent-device): iOS simulators and
Android emulators through the same `e2e/backend` contract the browser backend
implements. A test written against `screen`, `expect`, `app`, and `agent` runs
on a device target unchanged; nothing in `e2e` core knows this package exists.

## Install

```bash
npm install --save-dev e2e @e2edev/agent-device
```

`agent-device` needs Xcode with an iOS simulator runtime, or the Android SDK
with an emulator. Run `npx agent-device doctor` once before handing the target
to the runner.

```ts title="e2e.config.ts"
import { defineConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';

const iphone = agentDevice({ platform: 'ios', app: 'Settings' });
const pixel = agentDevice({ platform: 'android', app: 'com.android.settings' });

export default defineConfig({
  targets: [
    { name: 'iphone', platform: 'ios', backend: iphone },
    { name: 'pixel', platform: 'android', backend: pixel },
  ],
  workers: 1,
  agent: { executor: createAgent({ tools: agentDeviceTools(iphone, pixel) }) },
});
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
| `device` | Simulator or emulator name or id; a booted one is picked otherwise. |
| `session` | agent-device session name; defaults to `e2e-<target name>`. One run per session at a time. |
| `snapshot` | `'full'` (default, includes static text) or `'interactive'` (actionable nodes only). |

## What the backend declares

- **Observation**: the accessibility tree, projected onto the role vocabulary
  (iOS `Button` becomes `button`, `TextField` becomes `textbox`, `Cell` becomes
  `listitem`; Android `android.widget.TextView` becomes `text`, `EditText`
  becomes `textbox`, `Switch` becomes `switch`), with rects, a viewport, and
  pixels on request. Element identifiers (`ABOUT`, `android:id/title`) surface
  as the configured test id attribute.
- **Actions**: tap, double tap, long press, fill, clear, check/uncheck,
  `Enter`, single-character keys, swipe within a node, drag. `selectOption`,
  `setInputFiles`, and other keys fail with `UNSUPPORTED_CAPABILITY`.
- **Location**: every `screen` query, plus agent-device selectors through
  `device.locator('role=NavigationBar id=General')`.
- **Viewport swipe**, `app.back()`, `app.restart()`, `app.clearState()`, and
  screenshots under the attempt artifact directory. No `state` capability: a
  simulator has no portable session snapshot.

## Trace cache

The runner caches `agent.act` steps by their location anchor, and a device has
no address bar. This backend reports one anyway: `app://<bundle id>/<screen
title>`, with the title read off the navigation bar on iOS and the collapsing
toolbar on Android. A step recorded on
`app://com.apple.preferences/General` replays only when the app is on that
screen again, and a flow that stays within tap, type, and scroll replays with
zero model calls. Pin `app` so every attempt starts on the same screen, and
prefer the grammar over the `open_app` tool inside a step: a tool call is a
replay gap.

## The `device` fixture

Deterministic device management, recorded as `device.<method>` steps. Import
`test` from this package to have it typed.

```ts
import { test } from '@e2edev/agent-device';
import { expect } from 'e2e';

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
`enrollBiometrics`, `openApp`, `closeApp`, `foregroundApp`, `home`, `back`,
`alert`, `dismissKeyboard`, `clipboard`, `setClipboard`, and the `locator`
accessor.

## Agent tools

`@e2edev/agent-device/tools` exports `agentDeviceTools(...backends)`:
`open_app`, `swipe` (free-form, in logical pixels), `type_text` (into the
focused field, for editors that hide it from the tree), `alert`, and
`screenshot` (the model sees the image). Pass every device backend the config
declares: tool names are fixed, so two packs cannot be merged, and the pack
dispatches each call to the backend whose attempt is running. Tools are scoped
to the platforms of those backends, so a suite that mixes web and device
targets can hand the pack to one `createAgent`.

## Secrets

Secret fills need an origin the runner can check, and an `app://` location has
none, so `type_secret` is not available on a device target. Fill credentials
through a deterministic `screen` action in a setup step instead.

## Documentation

Full documentation lives at [e2e.dev](https://e2e.dev).
