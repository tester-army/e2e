# Examples

Standalone apps with three locator tests and two agent tests each.
Every app uses the same demo: enter a name and press Greet.

| Example | Technology | Runs on |
| --- | --- | --- |
| [with-vite](with-vite) | Vite + React | Chromium |
| [with-next](with-next) | Next.js App Router | Chromium |
| [with-expo](with-expo) | Expo + React Native | Chromium, iOS simulator, Android emulator |

Each folder installs published packages from npm and works outside this
repository. See its README for run commands. Agent tests need
`AI_GATEWAY_API_KEY`; without it, they skip.

## For contributors

Run the suite locally after changes. Update the README's "Last checked"
versions. CI does not run these examples. Oxlint and fallow exclude them.
Do not commit lockfiles. Keep the demo and tests consistent across examples.
