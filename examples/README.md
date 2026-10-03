# Examples

Each folder is a small, standalone project that shows how to set up e2e in
one technology. The app is the same demo screen in all of them: type a name,
press Greet, and the app says hello. Each suite has deterministic tests and
agent tests side by side.

| Example | Stack | Engine | Runs on |
| --- | --- | --- | --- |
| [`with-vite`](with-vite) | Vite + React | `@e2e-dev/web` | Chromium |
| [`with-next`](with-next) | Next.js App Router | `@e2e-dev/web` | Chromium |
| [`with-expo`](with-expo) | Expo (React Native) | `@e2e-dev/mobile` | iOS simulator, Android emulator |
| [`with-swiftui`](with-swiftui) | SwiftUI | `@e2e-dev/mobile` | iOS simulator |

Copy a folder out of the repo and it works on its own: every example
installs the published `e2e` packages from npm, with no link to this
monorepo. Each README covers what to run, which files e2e adds, and the
quirks of that technology's accessibility tree.

Agent tests skip themselves unless `AI_GATEWAY_API_KEY` is set. The
deterministic tests need no model.

## For contributors

- No CI runs these examples, and the root `pnpm check` ignores them (oxlint,
  fallow). Before you change one, run its suite by hand and update the
  versions on the "Last checked" line of its README.
- No lockfiles are committed (`examples/.gitignore`), so each install picks
  the latest release in the example's ranges, the way a new project would.
- Keep the demo screen the same everywhere: same copy, same test ids, same
  tests. A difference should come from the technology, and the README should
  say why.
