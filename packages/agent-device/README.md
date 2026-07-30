# @e2edev/agent-device

The mobile driver for [`e2e`](https://www.npmjs.com/package/e2e), built on
[agent-device](https://www.npmjs.com/package/agent-device).

It drives iOS simulators and Android emulators, and ships as its own package so
a project that only tests the web never installs a mobile toolchain.

## Install

```bash
npm install --save-dev e2e @e2edev/agent-device
```

A mobile target names the driver explicitly, because there is no default mobile
backend:

```ts title="e2e.config.ts"
import { defineConfig } from 'e2e';
import { agentDevice } from '@e2edev/agent-device';

export default defineConfig({
  targets: [
    {
      name: 'ios',
      platform: 'ios',
      driver: agentDevice(),
      app: 'com.example.app',
      device: 'iPhone 16',
      os: '18.0',
    },
  ],
});
```

`app` is a bundle identifier, an Android package name, or a path to a build
artifact (`.app`, `.ipa`, `.apk`, `.aab`) that is installed on first use.

## Requirements

- **iOS**: macOS with Xcode and its simulators installed.
- **Android**: the Android SDK, with at least one AVD created.

`mobile-0.1` covers simulators and emulators only. A physical device is
rejected: the reset, permission, and push primitives the specification requires
do not exist there.

## Options

```ts
agentDevice({
  reset: 'clear-state', // or 'relaunch' for an app with no data container
  shutdownOnDispose: true, // shut the simulator down when the run ends
});
```

`reset` defaults to `clear-state`, which wipes the app's data container before
each attempt so attempts cannot leak state into one another. A built-in system
app has no container to clear and needs `relaunch`, which does **not** isolate
state.

Each `agentDevice()` call owns one device, so parallel workers each get their
own simulator or emulator.

## Documentation

Full documentation lives at [e2e.dev](https://e2e.dev).
