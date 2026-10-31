# @e2e-dev/android (experimental)

An experimental Android engine for [e2e](https://e2e.tester.army). It runs
an [engine protocol](https://e2e.tester.army/docs/reference/engine-protocol)
server written in Java on the device, as an instrumentation, and drives the
device in process through `UiAutomation`: no adb call, shell process, or
XML dump per action. Docs: https://e2e.tester.army/docs/android

```ts
import { android } from '@e2e-dev/android';

export default {
  targets: [{ name: 'android', engine: android(), app: { bundleId: 'com.example.app' } }],
  workers: 1,
};
```

## Layout

- `server/java/` - the device server: an instrumentation listening on an
  abstract socket. Reads the tree from accessibility nodes and injects
  touches and keys. Logs each request's time under the `e2e-android` tag
  (`adb logcat -s e2e-android`).
- `src/transport.ts` - the host half: installs the server APK and the
  target's `appPath`, starts the instrumentation, and forwards a TCP port to
  its socket.
- `src/index.ts` - `android()`: `connectEngine` with the manifest,
  host-side locators, and the `device` fixture with `back()`.

## Build

Needs an Android SDK (`ANDROID_HOME`) and JDK 17. No Gradle. `pnpm pack`
and `pnpm publish` build the APK into the package (`prepack`); in the repo:

```bash
pnpm build                                     # every package, e2e first
pnpm --filter @e2e-dev/android build:server    # build/e2e-android-server.apk
```

## Run the mobile benchmark on it

With an emulator booted and the benchmark app (`dev.e2e.benchmark`)
installed:

```bash
cd apps/mobile-benchmark
node node_modules/e2e/dist/cli/bin.js run --config e2e.android.config.ts
BENCH_ENGINE=agent-device node node_modules/e2e/dist/cli/bin.js run --config e2e.android.config.ts
```

`pnpm --filter @e2e-dev/android bench -- --rounds 20` times single engine
calls on both engines.

## Not there yet

- One device per run (`workers: 1`); no device pool or emulator boot.
- No `device` controls beyond `back()`, no video, no `selector` locators.
- Text the virtual keyboard map cannot spell is set on the field, not
  typed key by key.
