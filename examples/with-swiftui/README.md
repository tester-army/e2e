# e2e with SwiftUI

A one-screen SwiftUI demo app with an e2e suite that drives it on an iOS
simulator: three tests that use locators only, and two that hand a step to an
agent and then check the result with a locator.

A native project has no `package.json`, so the tests live in their own
folder, `e2e/`, next to the Xcode project. That's the layout to copy into
your own app.

```
with-swiftui/
  HelloApp.xcodeproj    the Xcode project
  HelloApp/             the app: HelloApp.swift, ContentView.swift, assets, fonts
  e2e/                  the e2e project: package.json, e2e.config.ts, tests/
```

## Run it

You need Xcode with an iOS simulator and Node 22 or later.
`npx agent-device doctor` checks your setup.

```bash
xcrun simctl boot "iPhone 17 Pro"   # any iPhone simulator
cd e2e
npm install
npm run build:ios                   # xcodebuild into ../build
npm run install:ios                 # installs the .app on the booted simulator
npm run test:e2e
```

Rebuild and reinstall after you change the app. The first run compiles
agent-device's iOS runner, which takes a minute or two.

The agent tests skip themselves without a model key. To run them, set a
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key, or swap the
model in `e2e/e2e.config.ts` for [another provider](https://e2e.tester.army/docs/models):

```bash
AI_GATEWAY_API_KEY=... npm run test:e2e
```

## What e2e adds to a SwiftUI app

| File | What it does |
| --- | --- |
| `e2e/package.json` | `e2e` and `@e2e-dev/mobile` as dev dependencies, plus `ai` and `zod` for the agent. Scripts to build the app with `xcodebuild`, install it with `simctl`, and run the tests. |
| `e2e/e2e.config.ts` | One `ios` target that opens the app by its bundle id, `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project. `agents.default.model` is the model behind `agent.*` steps. |
| `e2e/tests/greeting.e2e.ts` | Deterministic tests with `getByTestId` and `getByText`. |
| `e2e/tests/agent.e2e.ts` | `agent.act` and `agent.assert`, each followed by a locator check that does not depend on the model. |

The Swift code needs nothing from e2e. The only change for testing is an
`accessibilityIdentifier` on each element a test touches.

`app.open()` launches the app fresh, so every test starts on an empty form.

## Test ids and what the tests see

`getByTestId` reads the accessibility identifier:

```swift
TextField("Name", text: $name, prompt: Text("Ada Lovelace"))
    .accessibilityIdentifier("name")
    .accessibilityLabel("Name")
Button(action: greet) { Text("Greet") }
    .accessibilityIdentifier("greet")
```

The accessibility tree differs from the code in a few ways worth knowing
before you write a locator:

- **A `TextField` with a `prompt` has no name.** Without
  `.accessibilityLabel`, the field reads as an unnamed `textbox`, and the
  agent has to guess what it is for.
- **`.textCase(.uppercase)` changes the label.** The button reads `GREET`, so
  `getByRole('button', 'Greet')` finds nothing. The test id doesn't change.
- **An empty field reports its prompt as its value.** Don't assert
  `toHaveValue('')` on an empty `TextField`.
- **`.accessibilityAddTraits(.isHeader)` is not a `heading`.** The title is a
  `text` node, so the tests use `getByText('Say hello')`.

## CI

In CI, build once and install the `.app` from the suite instead. Set
`app.appPath` to `../build/Build/Products/Debug-iphonesimulator/HelloApp.app`
and call `device.installApp()`, as shown in
[Point at your app](https://e2e.tester.army/docs/mobile#point-at-your-app).
[Mobile CI](https://e2e.tester.army/docs/mobile-ci) has a GitHub Actions
workflow for iOS.

## Add e2e to your own SwiftUI app

From your project's root:

```bash
npx e2e init e2e
```

That creates the `e2e/` folder. Pick **Mobile (iOS/Android)**, replace the Settings bundle id with yours, and
add `accessibilityIdentifier`s to the views your tests touch. Copy the
`build:ios` and `install:ios` scripts from `e2e/package.json` and point them
at your project and scheme.

The fonts in `HelloApp/Fonts/` are Stack Sans Notch, Inter, and DM Mono
under the SIL Open Font License (`HelloApp/Fonts/OFL.txt`).

Last checked with e2e 0.15.2, @e2e-dev/mobile 0.9.0, and Xcode 27 on an iOS
26.5 simulator.
