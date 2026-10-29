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

## Contributing

[e2e.tester.army/examples](https://e2e.tester.army/examples) lists these
examples and partner and community ones from other repositories, from
[`examples.json`](examples.json). To add yours, or to change an example
here, see [CONTRIBUTING.md](CONTRIBUTING.md).
