# @e2e-dev/android (experimental, private)

An Android engine that is an [engine protocol](../../docs/reference/engine-protocol.mdx)
server written in Java and running on the device. It proves that an engine
can live outside the runner's process and language, and it measures what
driving the device directly buys over `@e2e-dev/mobile` on agent-device.

- `server/java/` - the engine server: an instrumentation that listens on an
  abstract socket and drives the device in process through `UiAutomation`.
  It reads the tree from accessibility nodes and injects touches and keys,
  with no adb round trip, shell process, or XML dump per call.
- `src/transport.ts` - the host half: installs the server APK and the
  target's `appPath`, starts the instrumentation, and forwards a TCP port to
  its socket.
- `src/index.ts` - `android()`, the client: `connectEngine` with the
  manifest, host-side locators (`resolveLocators`), and a `device` fixture
  with `back()`.

## Build

Needs an Android SDK (`ANDROID_HOME`) and JDK 17. No Gradle. The root
`pnpm build` builds every package in order, this one after `e2e`, whose
`dist` it imports; the APK builds on its own:

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

## Measure

```bash
pnpm --filter @e2e-dev/android bench -- --rounds 20
```

Runs the same engine calls on both engines on the same screens and prints
the p50 and p95 latency of each.

## Results

Measured 2026-10-18 on a Mac mini (M5 Pro), Pixel 7 API 36 emulator,
mobile benchmark app, against `mobile()` on agent-device 0.21.28.

The deterministic suite (`e2e.android.config.ts`, 42 tests, one worker):

| Suite | agent-device | direct | Speedup |
| --- | --- | --- | --- |
| controls | 130.9s | 37.1s | 3.5x |
| flows | 47.7s | 11.9s | 4.0x |
| flows-lists | 110.1s | 72.8s | 1.5x |
| login-form | 28.7s | 8.6s | 3.3x |
| smoke | 3.8s | 1.4s | 2.6x |
| **total** | **321s** | **132s** | **2.4x** |

Both engines pass all 42. The direct engine declares the same device
surface as the mobile engine: `press` takes Enter, Space, or one character,
the keys a soft keyboard has, and refuses modifiers and other named keys.

Engine calls (`bench/bench.ts --rounds 20`, nearest-rank p50; init is one
cold sample, restart three, gestures and screenshots five, typing ten, the
rest twenty):

| Operation | Samples | agent-device | direct | Speedup |
| --- | --- | --- | --- | --- |
| init (cold) | 1 | 1593 ms | 168 ms | 9.5x |
| restart app | 3 | 887 ms | 156 ms | 5.7x |
| observe | 20 | 15.3 ms | 2.0 ms | 7.6x |
| locate | 20 | 9.1 ms | 1.5 ms | 5.9x |
| tap | 20 | 132 ms | 30.4 ms | 4.3x |
| tap row, next screen up | 5 | 365 ms | 160 ms | 2.3x |
| fill (19 chars) | 20 | 1028 ms | 4.4 ms | 231x |
| screenshot | 5 | 1459 ms | 65.7 ms | 22x |
| observe with pixels | 5 | 1469 ms | 51.2 ms | 29x |
| swipe | 5 | 402 ms | 465 ms | 0.9x |
| back, list up | 5 | 320 ms | 416 ms | 0.8x |
| keyboard.type (10 chars) | 10 | 67 ms | 333 ms | 0.2x |

The direct engine wins where agent-device spends an adb process or a
daemon hop per call. It loses where the app sets the pace:
- `swipe` waits for the list to come to rest, so a tap after it lands.
- `back` waits on the app's pop animation, which blocks accessibility
  queries.
- `keyboard.type` sends one key event per character, and React Native
  re-renders on each. agent-device commits the whole string through its
  IME.

`fill` sets the text with `ACTION_SET_TEXT`. agent-device types it
through its IME and reads it back.

## Not there yet

- One device per run (`workers: 1`); no device pool or emulator boot.
- No `device` controls beyond `back()`, no video, no state capture, no
  `selector` locators.
- Text that the virtual keyboard map cannot spell is set on the field,
  not typed key by key.
