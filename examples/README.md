# Examples

Standalone apps with three locator tests and two agent tests each.
Every app uses the same demo: enter a name and press Greet.

| Example | Technology | Runs on |
| --- | --- | --- |
| [with-vite](with-vite) | Vite + React | Chromium |
| [with-next](with-next) | Next.js App Router | Chromium |
| [with-astro](with-astro) | Astro | Chromium |
| [with-angular](with-angular) | Angular | Chromium |
| [with-expo](with-expo) | Expo + React Native | Chromium, iOS simulator, Android emulator |
| [with-swiftui](with-swiftui) | SwiftUI | iOS simulator |
| [with-compose](with-compose) | Jetpack Compose | Android emulator |
| [with-kotlin-multiplatform](with-kotlin-multiplatform) | Kotlin Multiplatform + Compose Multiplatform | Android emulator, iOS simulator |
| [with-flutter](with-flutter) | Flutter | Android emulator, iOS simulator |
| [with-maui](with-maui) | .NET MAUI | Android emulator, iOS simulator |

Each folder installs published packages from npm and works outside this
repository. See its README for run commands. Agent tests need
`AI_GATEWAY_API_KEY`; without it, they skip.

Start a new project from one with `npx e2e init my-app --example with-expo`.
`init` downloads the folder from the tag of the CLI's version.

## Hosted mobile devices

[with-limrun](with-limrun) runs the same five app-flow tests on hosted iOS
and Android devices. It reuses the SwiftUI and Compose apps above to check
forms, validation, updated results, and restart. No AI key is needed.

## For contributors

Run the suite locally after changes. Update the README's "Last checked"
versions. Every example but with-limrun runs nightly on GitHub against the
packages built from main (`.github/workflows/examples.yml`), and a new
example needs an entry there. Pull requests never run them. Oxlint and
fallow exclude them.
Do not commit lockfiles. Keep the demo and tests consistent across examples.
