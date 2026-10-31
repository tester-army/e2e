# @e2e-dev/ios (experimental)

A native iOS simulator engine for [e2e](https://e2e.tester.army). It is an
[engine protocol](https://e2e.tester.army/docs/reference/engine-protocol)
server written in Swift and hosted by an XCUITest bundle on the simulator,
so every observation and gesture runs in process, without agent-device.

Experimental: the API and behavior can change in any release. For
production suites use [`@e2e-dev/mobile`](https://e2e.tester.army/docs/mobile).

## Install

Needs macOS with Xcode and a booted iOS simulator.

```bash
npm install --save-dev e2e @e2e-dev/ios
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { ios } from '@e2e-dev/ios';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'ios',
      engine: ios(),
      app: { bundleId: 'com.example.app', appPath: './build/MyApp.app' },
    },
  ],
} satisfies E2EConfig;
```

The package ships the server's Xcode project. The first run builds it with
`xcodebuild` into `~/Library/Caches/e2e/ios-server` (`E2E_IOS_BUILD_DIR`
overrides), once per package version and Xcode. Run `npx e2e-ios-build`
first in CI, so the first test does not wait for the build.

See the [docs page](https://e2e.tester.army/docs/ios-engine) for options and
limits.

## Develop

```bash
pnpm build                                  # every package, e2e first
pnpm --filter @e2e-dev/ios build:server     # build the Swift server now
E2E_IOS_UDID=<udid> pnpm --filter @e2e-dev/ios bench -- --rounds 10
```

- `server/` - the Xcode project: a host app and the `E2EServer` UI test
  bundle. `EngineServer.testServe` listens on a localhost port and answers
  the protocol on the main thread. `Device.swift` reads the tree from one
  XCUITest snapshot and acts with XCUITest gestures.
- `src/transport.ts` - installs the target's `appPath`, starts the test with
  `xcodebuild test-without-building` on a free port, and connects.
- `src/index.ts` - `ios()`: `connectEngine` with the manifest, host-side
  locators, restart and reset through `simctl`, and a `device` fixture with
  `back()`.

The mobile benchmark runs on it with
`apps/mobile-benchmark/e2e.ios.config.ts`; `BENCH_ENGINE=agent-device` runs
the same selection on `@e2e-dev/mobile`.
