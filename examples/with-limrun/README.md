# App flows on Limrun

Run the same five tests on a hosted iOS simulator and Android emulator.
The suite fills a form, submits it, checks validation and updated results,
and restarts the app. Tests use stable test IDs and visible text through the
standard `app`, `screen`, and `expect` APIs. No AI key is needed.

This test project reuses the greeting apps in [with-swiftui](../with-swiftui)
and [with-compose](../with-compose). Keep those folders beside this one when
following the build commands below. Prebuilt apps work too.

## Install

Run these commands from `examples/with-limrun`.
Use Node.js 22.22.3+, 24.8+, or 26+.

Install the dependencies after `@e2e-dev/limrun` is published:

```sh
npm install
```

For an unpublished checkout, run `pnpm install --frozen-lockfile` and
`pnpm version-packages` at the root of a disposable checkout to apply the
pending releases. Then build and pack `e2e`, `@e2e-dev/mobile`, and
`@e2e-dev/limrun`, and install those tarballs here in place of their registry
versions.

Set `LIMRUN_API_KEY` to a Limrun key with instance control permissions.
Android tests also need `adb` from Android SDK Platform-Tools on `PATH`.
The test runner needs no local simulator, emulator, or Xcode installation.

## Build the apps

Build the existing native apps with the Limrun CLI. The CLI uses `lim login`
or `LIM_API_KEY`; the test provider separately reads `LIMRUN_API_KEY`.
These commands upload temporary artifacts to your account.

```sh
lim xcode build ../with-swiftui --scheme HelloApp --upload e2e-limrun-greeting-ios.tar.gz --upload-ttl 24h
lim gradle build ../with-compose --upload e2e-limrun-greeting.apk --upload-ttl 24h
mkdir -p build
lim assets pull e2e-limrun-greeting-ios.tar.gz --output build
lim assets pull e2e-limrun-greeting.apk --output build
tar -xzf build/e2e-limrun-greeting-ios.tar.gz -C build
```

The config expects `build/HelloApp.app` and `build/e2e-limrun-greeting.apk`.
To use builds elsewhere, set `GREETING_IOS_APP` and `GREETING_ANDROID_APP`
to their paths.

## Run the tests

Run both targets with video recording:

```sh
npm test -- --video
```

To build and test only one platform, run its build command above, then:

```sh
npm test -- --target ios --video
npm test -- --target android --video
```

The provider creates a device and installs the app before testing each
target. Every test starts the app with `app.open()`. Both targets execute
the same [test file](tests/greeting.e2e.ts) without platform branches.

| Flow | What the test checks |
| --- | --- |
| Open the app | The heading, name field, and submit button are visible. |
| Correct an empty submission | The error appears, then disappears after a valid name produces a greeting. |
| Trim input | Spaces around a full name do not appear in the greeting. |
| Submit again | The second greeting replaces the first. |
| Restart | The previous greeting disappears and the empty form requires a name again. |

Videos and screenshots are under `.e2e/`, alongside the run reports. The successful correction
also saves a screenshot named `greeting`. The run releases its devices at exit.

## Use your own app

Change `app.bundleId` and `app.appPath` in [e2e.config.ts](e2e.config.ts).
Replace the greeting assertions with your app's form, navigation, or other
user flows. Use test IDs or accessible names that the app exposes on both platforms.

With agent-device 0.21.22, the Limrun iOS transport does not support
`locator.press('Enter')`. This suite taps the app's Greet button to submit.
Restarting preserves persisted app data; these greeting apps keep their
form state in memory.

Last checked: 2026-10-09, e2e 0.18.0, mobile 0.11.0, Limrun provider 0.2.0,
agent-device 0.21.22, and Limrun SDK 0.59.0. All ten tests passed on hosted
iOS and Android devices with video recording. The provider and mobile
packages were installed from local release tarballs.
