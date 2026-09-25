# @e2edev/mobile-benchmark

An Expo app (iOS and Android) of self-contained scenarios that are hard to
automate on a device, and the e2e suites written against them. Every
scenario isolates one awkward mobile surface: a merged accessibility tree, a
hidden one, native alerts stacked on modals, a keyboard covering the submit
button, virtualized lists whose off-screen rows are not in the tree, a
WebView, an OS permission dialog, out-of-process payment sheets. A test
either handles that surface or fails for exactly that reason.

The app is copied from `apps/mobile-benchmark` in the tester-army monorepo,
where the same scenarios gate the autonomous QA agent. Keep diffs against
that source minimal so scenarios port both ways. Scenarios distilled from
real production apps name no company: describe the surface, never the
source.

## Layout

The Expo project sits at the package root, unlike `web-benchmark`, because
Expo's tooling (Metro, CNG, autolinking) reads `app.json` and `package.json`
from the directory it runs in.

- `src/examples.ts`: the catalog. Every scenario's `component`, `name`,
  `description`, and optional `platform` / `screenOptions`. One component
  per scenario in `src/Examples/`; the home list renders one row per
  scenario, its test id the scenario name, and pushes each as its own stack
  screen.
- `modules/apple-pay-lab`: the local Expo module (PassKit, iOS only) behind
  the two Apple Pay scenarios.
- Network Status, Location Reader, and Biometric Lock are not hard surfaces:
  each prints what the OS reports (expo-network, expo-location,
  expo-local-authentication) so the `device` fixture's `setNetwork`,
  `setAirplaneMode`, `setLocation`, `clearLocation`, `enrollBiometrics`, and
  `setBiometrics` have something to be read back from, like Control
  Inventory does for the runner verbs. `tests/device-fixture.e2e.ts` covers
  them and declares, with the reason, what the tooling cannot do yet: on the
  iOS simulator agent-device's wifi and airplane settings only override the
  status bar, its Face ID goes through a `simctl biometric` subcommand the
  installed Xcode has to declare (Xcode 27.0 does not), and on Android
  `clearLocation` turns location services off for the whole emulator with
  no fixture verb to turn them back on, so that test restores them through
  adb.
- `e2e.config.ts` + `tests/`: the deterministic suite, locators only.
- `e2e.agent.config.ts` + `tests-agent/`: the agentic suite, derived from the
  deterministic config. One `agent.act` per scenario with the catalog
  description as its goal and a deterministic check on the success message.
  A scenario whose tree is merged or hidden on purpose tells the model so
  and is judged from a screenshot; one whose surface renders out of process
  (PassKit, the photo picker) says the sheet is not in the tree, and the
  model asks for the screenshot itself; the photo picker seeds its receipt
  into every booted simulator first. Scenarios the
  harness cannot finish yet are declared with a `gap` and skip with that
  reason, so every run shows what is still missing.

The deterministic suite runs in CI on every pull request (`.github/workflows/mobile.yml`):
an iOS simulator on a macOS runner and an Android emulator on Linux, with the
Expo build cached per native fingerprint and its JS bundle repacked on a hit.
The agentic suite runs there too, for this repository's branches. It replays
the recordings committed under `.e2e/cache/` where they exist and calls the
model for a step with none: the iOS entries are recorded on a Mac with
`test:agent` (below) and committed in the same pull request as the scenario
change; nobody has recorded on an Android emulator yet, so that side spends
model calls until an emulator recording is committed.

## Running

Native projects are generated with CNG (`ios/` and `android/` are ignored);
`expo run:*` prebuilds them on first use.

```bash
pnpm build                                              # from the repo root, once
pnpm --filter @e2edev/mobile-benchmark ios              # build + install on the booted simulator
pnpm --filter @e2edev/mobile-benchmark android          # same for the running emulator
pnpm --filter @e2edev/mobile-benchmark test             # tests/ on both targets
AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/mobile-benchmark test:agent
```

The configs pin the app by bundle id (`dev.e2e.benchmark`) and expect it
installed. To install a build first, point `E2E_MOBILE_BENCHMARK_IOS_APP` at
a simulator `.app` or `E2E_MOBILE_BENCHMARK_ANDROID_APP` at an `.apk`; the
engine installs it once per worker. `eas build --profile benchmark` produces
both (link your own EAS project first with `eas init`).

Run one target or one file at a time from the package directory while
authoring:

```bash
cd packages/mobile-benchmark
node node_modules/e2e/dist/cli/bin.js run tests/login-form.e2e.ts --target ios-simulator
```

Android note: the Android Gradle Plugin's prefab step fails on very new JDKs
(observed on JDK 26). Build with JDK 17 through 21. A debug build fetches its
bundle from Metro and cold-starts in about ten seconds on the emulator; a
suite that reopens the app per test is more reliable against a release build
(`npx expo run:android --variant release`), which is what CI runs.

## Scenario contract

Every scenario ends in a deterministic success state. Where the
accessibility tree is intact, the terminal element carries
`testID="success-message"`. The adversarial scenarios (Broken Accessibility,
Vision Only, Flattened Registration Form, Flattened Login) omit test ids and
hide or merge the tree on purpose, so success is only visible in pixels.

The Login Form and Flattened Login account is declared as the `benchmark`
credential in `e2e.config.ts`, so tests reach it through
`credentials.user('benchmark')`.

| Scenario                    | What it gates                                                               |
| --------------------------- | --------------------------------------------------------------------------- |
| Login Form                  | Form filling, validation errors, credential handling                        |
| Infinite Scroll List        | Paginated scrolling to a target deep in a list                              |
| Modal Flow                  | RN `Modal` + native `Alert` stacking                                        |
| Bottom Tabs                 | Tab navigation and acting inside a tab                                      |
| Text Input Variations       | Secure, numeric, and multiline inputs gating a submit button                |
| Broken Accessibility        | `accessible={true}` merges the whole screen into one a11y node              |
| Vision Only                 | A11y tree fully hidden (canvas/Flutter-style app), pure vision              |
| Gestures                    | Long-press, swipe, double-tap                                               |
| Async States                | Initial loading, pull-to-refresh, transient toast                           |
| Debounced Search            | Debounced input + async results                                             |
| Huge Virtualized List       | Long scroll jumps sized from scroll extent (virtualized rows)               |
| Flattened Registration Form | Vision-focused typing into an `accessible={true}` merged form               |
| Flattened Login             | Credential fill via focused typing when `accessible={true}` hides the tree  |
| Sticky Chrome Target        | Off-screen tap scrolled clear of a sticky footer                            |
| WebView Accessibility       | Web semantics projected into the native a11y tree; fill + submit a web form |
| Permission Prompt           | OS permission dialog (outside the app a11y tree) + denied-state recovery    |
| Photo Picker                | Selecting a seeded photo via the out-of-process system photo picker         |
| Product Catalog             | Near-identical repeated cards, drill-in detail, stepper, cart verification  |
| Error Recovery              | Retryable error banner, then a destructive-confirm modal                    |
| Choice Controls             | Radio group, checkboxes, switch, keyboard-dismiss-gated submit              |
| Stripe PaymentSheet         | Stripe SDK-owned test checkout sheet with native keyboard and moving refs   |
| Sequential Onboarding       | Auto-focused wizard steps where the keyboard covers Continue                |
| Apple Pay (iOS)             | Out-of-process PassKit sheet the agent must authorize                       |
| Apple Pay Billing (iOS)     | PassKit sheet requiring a billing address filled from vision before paying  |

### Apple Pay fixture

`modules/apple-pay-lab` presents the PassKit sheet. The app carries the
`com.apple.developer.in-app-payments` entitlement for the placeholder
`merchant.dev.e2e.benchmark` merchant id; simulators do not validate the
merchant against a provisioning profile, so the sheet presents with
simulated test cards. It renders out of process and never appears in the
app's own accessibility tree, which is what the scenario gates.

### Stripe PaymentSheet fixture

The scenario calls `initPaymentSheet` and `presentPaymentSheet` from
`@stripe/stripe-react-native`, so the sheet, card fields, validation, focus,
and keyboard handling are Stripe's own. It uses Stripe's public React Native
example backend for disposable test-mode customers and PaymentIntents; no
secret and no real charge is involved, but it needs network access to that
demo backend.

## Adding a scenario

1. Create `src/Examples/YourCase.tsx`. Keep it deterministic (fixed data,
   fixed timings) and end in a persistent success state.
2. Register it in `src/examples.ts` with a description of what the agent
   must do; the description is the agentic suite's goal.
3. Add it to `tests-agent/scenarios.e2e.ts`, and to `tests/` when locators
   alone can finish it. If the case is about degraded accessibility, hide or
   merge the tree on purpose and skip test ids: that is the point.
4. If it came from a real app, describe the surface, not the company.
