# @e2e-dev/ios (experimental, private)

An iOS engine that is an [engine protocol](../../docs/reference/engine-protocol.mdx)
server written in Swift, hosted by an XCUITest bundle on the simulator. It
measures what driving the app directly from XCUITest buys over
`@e2e-dev/mobile` on agent-device, and shows a second language behind the
same protocol after the Java Android engine.

- `server/` - the Xcode project: a host app and the `E2EServer` UI test
  bundle. `EngineServer.testServe` listens on a localhost port (a simulator
  shares its Mac's loopback) and answers the protocol on the main thread.
  `Device.swift` reads the tree from one XCUITest snapshot and acts with
  XCUITest gestures at the observed frames.
- `src/transport.ts` - the host half: installs the target's `appPath`,
  starts the test with `xcodebuild test-without-building` on a free port,
  waits for it to listen, and connects.
- `src/index.ts` - `ios()`, the client: `connectEngine` with the manifest,
  host-side locators, and a `device` fixture with `back()`.

## Build

Needs Xcode. The root `pnpm build` compiles the TypeScript; the server
builds on its own:

```bash
pnpm build                                  # every package, e2e first
pnpm --filter @e2e-dev/ios build:server     # build/DerivedData/.../*.xctestrun
```

## Run the mobile benchmark on it

With the benchmark app (`dev.e2e.benchmark`) installed on a booted
simulator:

```bash
cd apps/mobile-benchmark
E2E_IOS_UDID=<udid> node node_modules/e2e/dist/cli/bin.js run --config e2e.ios.config.ts
E2E_IOS_WAIT_FOR_IDLE=0 E2E_IOS_UDID=<udid> node node_modules/e2e/dist/cli/bin.js run --config e2e.ios.config.ts
BENCH_ENGINE=agent-device E2E_MOBILE_BENCHMARK_IOS_DEVICE=<udid> node node_modules/e2e/dist/cli/bin.js run --config e2e.ios.config.ts
```

## Measure

```bash
E2E_IOS_UDID=<udid> pnpm --filter @e2e-dev/ios bench -- --rounds 10
```

Runs the same engine calls on agent-device, on this engine, and on this
engine with `waitForIdle: false`, and prints the p50 of each.

## Results

Measured 2026-10-18 on a Mac mini (M5 Pro), iPhone 17 Pro simulator on iOS
26.5, mobile benchmark app, against `mobile()` on agent-device 0.21.28, both
with the benchmark's `transition: 1500`.

The deterministic suite (`e2e.ios.config.ts`, 41 tests, one worker): both
engines pass all 41, twice in a row.

| Suite | agent-device | Swift | Speedup |
| --- | --- | --- | --- |
| controls | 164.5s | 138.5s | 1.2x |
| flows | 69.5s | 57.3s | 1.2x |
| flows-lists | 233.3s | 231.2s | 1.0x |
| login-form | 47.1s | 28.1s | 1.7x |
| smoke | 8.9s | 6.4s | 1.4x |
| **total** | **523s** | **461s** | **1.13x** |

It matches the mobile engine where the platform gives no signal: React
Native's checkbox and radio roles come out of the accessibility value, a
uniquely addressed node is tapped as an XCUITest element (which scrolls a
covered one clear and reaches another process's sheet, such as Save
Password), and a control that arrived with the last action waits out the
transition budget, since a presenting view drops touches while it reports
its final frame. Restart and `clearState` relaunch from the Mac with
`simctl`.

Engine calls (`bench/bench.ts --rounds 10`, p50; the bench runs this engine
with its default 500 ms transition):

| Operation | agent-device | Swift | Swift, no idle wait |
| --- | --- | --- | --- |
| observe | 94.4 ms | 18.0 ms | 17.6 ms |
| locate | 76.2 ms | 14.6 ms | 14.4 ms |
| screenshot | 671 ms | 105 ms | 104 ms |
| fill (19 chars) | 4852 ms | 1989 ms | 1538 ms |
| keyboard.type (10 chars) | 1213 ms | 429 ms | 428 ms |
| tap | 484 ms | 422 ms | 390 ms |
| tap row, next screen up | 5 of 5 failed | 1631 ms | 851 ms |
| back, list up | 1055 ms | 1710 ms | 1034 ms |
| swipe | 558 ms | 1433 ms | 1423 ms |
| restart app | 710 ms | 1705 ms | 1714 ms |
| init (cold) | 3487 ms | 1355 ms | 1378 ms |

Reads are 5-6x faster: one XCUITest snapshot and a screenshot in process,
with no daemon or HTTP hop. Gestures are where XCUITest itself sets the
pace: its idle waits, and `press(forDuration:thenDragTo:)` taking over a
second for a swipe. Restart waits until the relaunched app answers an
observation. The next lever is XCTest's private event synthesis for
gestures, what WebDriverAgent uses.

## `waitForIdle: false`

XCUITest waits for the app to go idle before and after every gesture.
`ios({ waitForIdle: false })` replaces that private wait with a no-op, as
WebDriverAgent can, so a gesture returns once its events are delivered and
the harness's polling waits for the outcome. It is private API and can
break with any Xcode release.
