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

## Add your example to e2e.tester.army

[e2e.tester.army/examples](https://e2e.tester.army/examples) lists every
example in [`examples.json`](examples.json): the official ones, which the e2e
team maintains in this folder and in other tester-army repositories, and
community examples in their own GitHub repositories. To list
yours, open a pull request that adds an entry to `examples`:

```json
{
  "slug": "nuxt-auth",
  "title": "e2e with Nuxt and Auth.js",
  "shortTitle": "Nuxt + Auth.js",
  "description": "Sign-in and protected pages in a Nuxt app, tested with locators and the agent.",
  "source": "community",
  "repository": "https://github.com/your-name/nuxt-auth-e2e",
  "author": { "name": "Your Name", "github": "your-name" },
  "license": "MIT",
  "tags": { "framework": ["nuxt", "vue"], "useCase": ["authentication"], "platform": ["web"] }
}
```

- `repository` is a public GitHub repository, or a folder in one
  (`https://github.com/<owner>/<repo>/tree/<ref>/<path>`). Its `README.md`
  becomes the example's page, so explain how to install and run it there.
- `source` is always `community`. `official` is reserved for examples the
  e2e team maintains under the tester-army organization.
- `tags` take ids from the `tags` lists at the top of the file. Each kind is
  a filter on the site: `framework` (put the main one first), `useCase`
  (what the example shows beyond its stack), and `platform`. If a tag you
  need is missing, add it in the same pull request.
- The card shows the e2e logo. An example about one framework or one
  company's product (Stripe, Clerk) can show that logo instead: set `icon` to a file in [`icons/`](icons), adding
  the file and its source in `icons/README.md` if it is new.
- `slug` is the page's address, `e2e.tester.army/examples/<slug>`.

`pnpm check:examples` validates the file. On your pull request it also
checks that your README can be fetched. Your editor can autocomplete the
fields from [`examples.schema.json`](examples.schema.json). The site
rebuilds when the change is merged.

## For contributors

Every example folder here also needs an official entry in `examples.json`;
`pnpm check:examples` fails while a folder here has none.

Run the suite locally after changes. Update the README's "Last checked"
versions. Every example but with-limrun runs nightly on GitHub against the
packages built from main (`.github/workflows/examples.yml`), and a new
example needs an entry there. Pull requests never run them. Oxlint and
fallow exclude them.
Do not commit lockfiles. Keep the demo and tests consistent across examples.
