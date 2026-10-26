# Keyboard signal before delayed app layout

Local diagnostic, iPhone 15 Pro simulator on iOS 27.0, agent-device 0.21.28.
This is a controlled focus-driven relayout, not a reproduction of the original
consumer's exact timing. Its original raw capture was not retained.

The native keyboard appears while JavaScript handles a bounded 300 ms workload.
The app then moves an existing button. The first post-focus snapshot already has
`Keyboard`/`Key` nodes, so the engine's existing `keyboardShowing` predicate is true,
although the button still has its pre-focus rectangle. The key plane was
`(0, 568, 393, 226)`, inside the 393 × 852 viewport, and a screenshot confirmed
the software keyboard was visible. No measured keyboard fact
was returned by this SDK capture; the predicate uses its existing node fallback.

| Capture received after focus started | Keyboard nodes | Button y |
| --- | ---: | ---: |
| Before focus | 0 | 418.67 |
| 483 ms | 38 | 418.67 |
| 562 ms | 38 | 418.67 |
| 711 ms | 38 | 418.67 |
| 785 ms | 38 | 258.67 |

This establishes the signal needed by the new condition. It does not establish
that the missing original capture contained the same signal.

## Diagnostic component

In an Expo host, use this as a separate entry point. The workload deliberately
makes the timing window observable; it is not an application fix or a new wait
in the engine.

```tsx
import { registerRootComponent } from 'expo';
import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

function Probe() {
  const [count, setCount] = useState(0);
  const [shift, setShift] = useState(0);
  return <View style={{ flex: 1 }}>
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16,
      transform: [{ translateY: -shift }] }}>
      <TextInput testID="probe-input" placeholder="Probe input"
        style={{ borderWidth: 1, padding: 12 }}
        onFocus={() => {
          const until = performance.now() + 300;
          while (performance.now() < until) {}
          setShift(160);
        }} onBlur={() => setShift(0)} />
      <Pressable testID="probe-action" onPress={() => setCount(n => n + 1)}
        style={{ padding: 12, backgroundColor: '#ddd' }}>
        <Text>Probe action</Text>
      </Pressable>
      <Text testID="probe-result">Actions: {count}</Text>
    </View>
  </View>;
}
registerRootComponent(Probe);
```

The local native host came from `apps/mobile-benchmark`, with the scenarios
replaced only in a separate diagnostic bundle. The generated host initially
trapped at `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` under
Xcode 27.1/iOS 27.0. Its ignored native files were adapted to create a
`UIWindow(windowScene:)` in a `UIWindowSceneDelegate`, then start the existing
React Native factory there. A scene configuration was returned from the app
delegate, and `UIApplicationSceneManifest` declared single-scene support.
No benchmark scenario or committed native application source was changed.
This is not an unmodified mobile benchmark suite pass.

Build the host following `apps/mobile-benchmark/README.md`. Save the component
as `keyboard-signal-probe.local.tsx` there and export its diagnostic bundle:

```sh
pnpm --filter @e2e-dev/mobile-benchmark exec expo export:embed \
  --entry-file keyboard-signal-probe.local.tsx --platform ios --dev false \
  --bundle-output /tmp/probe.jsbundle --max-workers 2
```

Copy the native `.app`, replace its `main.jsbundle` with that bundle, ad-hoc sign,
and install it on an owned simulator. Capture the initial tree through
`client.capture.snapshot({raw: true})`, press the returned `probe-input` ref,
and capture again serially. Record keyboard/key-node presence and
`probe-action.rect` from each same capture, with receipt times.

## Verification

- Same focused scripted-client regressions on PR base `93f77d8`, tests only:
  **17 failed, 4 passed**. Candidate: **21 passed**. All **366** mobile unit
  tests and `pnpm check` pass.
- Built CLI, one worker, zero retries, `transition: 500`, on the same diagnostic
  binary: base passed 1/1, candidate passed 1/1. Test bodies took 3.71 s and
  4.24 s respectively. These single runs are compatibility observations,
  not a performance benchmark or proof of a deterministic native failure.
- The unchanged-keyboard tests use a stopped fake clock and verify no pending
  transition timer after type/fill/clear. The new rule adds no unconditional
  text-entry wait.
