# e2e with Expo

A one-screen Expo demo app with an e2e suite that drives it on an iOS
simulator or an Android emulator: three tests that use locators only, and two
that hand a step to an agent and then check the result with a locator.

## Run it

You need Xcode with an iOS simulator, or the Android SDK with an emulator.
`npx agent-device doctor` checks your setup.

```bash
npm install
npm run ios:release      # builds a Release app and installs it on a simulator
npm run test:e2e:ios
```

For Android, start an emulator, then run `npm run android:release` and
`npm run test:e2e:android`. The Android build needs JDK 17, the version
React Native targets: point `JAVA_HOME` at one. A newer JDK, such as the
JDK 25 that recent Android Studio bundles, fails the native CMake step with
"A restricted method in java.lang.System has been called".

A Release build bundles the JavaScript, so no Metro server needs to run while
the tests do. Rebuild after you change the app. The first run also compiles
agent-device's iOS runner, which takes a minute or two.

The agent tests skip themselves without a model key. To run them, set a
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key, or swap the
model in `e2e.config.ts` for [another provider](https://e2e.tester.army/docs/models):

```bash
AI_GATEWAY_API_KEY=... npm run test:e2e:ios
```

## What e2e adds to an Expo app

| File | What it does |
| --- | --- |
| `package.json` | `e2e` and `@e2e-dev/mobile` as dev dependencies, plus `ai` and `zod` for the agent. One build script and one test script per platform. |
| `e2e.config.ts` | An `ios` and an `android` target, both opening the app by the bundle id in `app.json`. `agents.default.model` is the model behind `agent.*` steps. |
| `tests/greeting.e2e.ts` | Deterministic tests with `getByTestId` and `getByText`. |
| `tests/agent.e2e.ts` | `agent.act` and `agent.assert`, each followed by a locator check that does not depend on the model. |

`app.open()` launches the app fresh, so every test starts on an empty form.

## Test ids and what the tests see

`getByTestId` reads the accessibility identifier on iOS and the resource id
on Android. In React Native, both come from the `testID` prop:

```tsx
<TextInput testID="name" accessibilityLabel="Name" />
<Pressable testID="greet" accessibilityRole="button" onPress={greet}>
```

The tree differs from the code in a few ways worth knowing before you write
a locator. The tests stick to test ids and text, which read the same on both
platforms.

- **`textTransform: 'uppercase'` changes the label.** On both platforms the
  button reads `GREET`, so `getByRole('button', 'Greet')` finds nothing. The
  test id doesn't change.
- **An empty field shows its placeholder.** iOS reports it as the field's
  value, Android as its text. Don't assert `toHaveValue('')` on an empty
  `TextInput`.
- **Roles differ by platform.** Android reads `accessibilityRole="header"`
  as a `heading` and `accessibilityRole="alert"` as an `alert`. On iOS the
  title is a plain `text` node and the error has no role, so
  `getByRole('heading', 'Say hello')` passes on Android and fails on iOS.

## Development builds and CI

- **Development build.** To test against `expo start` instead of a Release
  build, see [Expo development builds](https://e2e.tester.army/docs/mobile#expo-development-builds).
  It uses launch arguments that open the dev server and hide the dev menu.
- **Install from the suite.** In CI you usually build once and install the
  `.app` or `.apk` from the suite instead. Set `app.appPath` and call
  `device.installApp()`, as shown in [Point at your app](https://e2e.tester.army/docs/mobile#point-at-your-app).
  [Mobile CI](https://e2e.tester.army/docs/mobile-ci) has workflows for
  GitHub Actions, EAS, Bitrise, and Codemagic.

## Add e2e to your own Expo app

```bash
npx e2e init
```

Pick **Mobile (iOS/Android)**, replace the Settings bundle id with yours, and
put `testID`s on the elements your tests touch.

Last checked with e2e 0.15.2, @e2e-dev/mobile 0.9.0, and Expo SDK 57 on an
iOS 26.5 simulator (Xcode 27) and an Android 16 (API 36) emulator (JDK 17).
