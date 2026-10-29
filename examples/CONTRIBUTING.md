# Contributing an example

[e2e.tester.army/examples](https://e2e.tester.army/examples) lists every
example in [`examples.json`](examples.json): the official ones, which the e2e
team maintains in this folder and in other tester-army repositories, and
partner and community examples in their own GitHub repositories. Built something with
e2e? Add it with a pull request.

## Add your example

1. Put your example in a public GitHub repository, or a folder in one, with
   a `README.md` that says what it tests and how to install and run it. The
   README becomes the example's page on the site. If your docs live in
   another Markdown file, or you have none, see `readme` below.
2. Add an entry to `examples` in [`examples.json`](examples.json):

   ```json
   {
     "slug": "nuxt-auth",
     "title": "e2e with Nuxt and Auth.js",
     "shortTitle": "Nuxt + Auth.js",
     "description": "Sign-in and protected pages in a Nuxt app, tested with locators and the agent.",
     "source": "community",
     "repository": "https://github.com/your-name/nuxt-auth-e2e/tree/<commit sha>",
     "author": { "name": "Your Name", "github": "your-name" },
     "license": "MIT",
     "tags": { "framework": ["nuxt", "vue"], "useCase": ["authentication"], "platform": ["web"] }
   }
   ```

3. Open the pull request. CI validates the entry and fetches your README;
   if you have the repository installed, `pnpm check:examples` runs the same
   check locally. The site updates once the pull request is merged.

Your editor can autocomplete the fields from
[`examples.schema.json`](examples.schema.json).

## The fields

- `slug` is the page's address, `e2e.tester.army/examples/<slug>`.
- `repository` is `https://github.com/<owner>/<repo>/tree/<ref>`, or
  `https://github.com/<owner>/<repo>/tree/<ref>/<path>` for a folder. The
  `<ref>` of a community example is the full SHA of the commit the pull
  request was reviewed at, so the page cannot change under it; open another
  pull request to move it forward.
- `readme` is only for a folder without a `README.md`, and left out
  otherwise. Set it to a Markdown file in the same repository at the same
  commit, `https://github.com/<owner>/<repo>/blob/<commit sha>/<path>.md`,
  to render that file instead, or to `false` for no README: the page then shows the entry's
  details and links to the code in `repository`.
- `source` is always `community`. `official` is reserved for examples the
  e2e team maintains under the tester-army organization, and `partner` for
  examples a partner company verifies and maintains in its own repository,
  which the e2e team sets once a partnership is agreed; the repository must
  belong to the entry's `author.github`. The site shows a
  partner example with a blue seal: "Verified and maintained by" its
  `author.name`, which links to the partner's landing page in
  `author.website` (required on a partner example, and only there).
- `license` is the example's SPDX identifier, such as `MIT`. Set
  `licenseUrl` to link your LICENSE file; without it, the site links to the
  license on spdx.org.
- `tags` take ids from the `tags` lists at the top of the file. Each kind is
  a filter on the site:
  - `framework`: the stack, the main one first
  - `useCase`: what the example shows beyond its stack
  - `platform`: where the tests run

  If a tag you need is missing, add it to the list in the same pull request.
- `icon` is optional. The card shows the e2e logo; an example about one
  framework or one company's product (Stripe, Clerk) can show that logo
  instead. Set `icon` to a file in [`icons/`](icons), and list a new file's
  source in [`icons/README.md`](icons/README.md).

## What we look for

- It uses e2e and the tests pass.
- Its README explains how to run it, so someone can start from the page.
  An example without one (`readme: false`) can still be listed; its page
  asks for a README and links the code.
- It shows something the listed examples do not: a framework, a service, or
  a use case.
- It has a license.

## Official examples

The folders here are official examples, maintained by the e2e team:

- Each folder needs an official entry in `examples.json` and a preset in
  `packages/e2e/src/cli/init/examples.ts`; `pnpm check:examples` fails
  without them.
- Run the suite locally after changes, and update the README's "Last
  checked" versions.
- Every example runs nightly on GitHub against the packages
  built from main (`.github/workflows/examples.yml`); a new example needs an
  entry there. Pull requests never run them. Oxlint and fallow exclude them.
- Do not commit lockfiles. Keep the demo and tests consistent across
  examples.
