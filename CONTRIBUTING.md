# Contributing

Contributions are welcome, no matter how large or small. Bug reports and docs
fixes count as much as features.

## License and contribution terms

The code is Apache-2.0 (see [`LICENSE`](./LICENSE)). There is no CLA and
no DCO bot. Section 5 of the license covers contributions: by opening a pull
request you agree that your contribution is licensed under the same
Apache-2.0 terms as the project (inbound = outbound). Only submit work you
have the right to license that way.

Please read the [code of conduct](./CODE_OF_CONDUCT.md) before you post.
Security issues go through [`SECURITY.md`](./SECURITY.md), not the issue
tracker.

## The contract

There is no separate spec document. The code is the contract, pinned in three
places, and a change to any of them is a contract change:

- The emitted `packages/e2e/dist/index.d.ts` and `dist/engine/index.d.ts`
  are the public API. `packages/e2e/tests/types/sdk-types.ts` holds
  compile-time assertions for the parts that are easy to loosen by accident;
  it runs under `typecheck`.
- Wire formats are the JSON Schemas in `packages/e2e/schema/` (report,
  session, agent judgment, agent tool), each with a valid and an invalid
  fixture. A wire change edits the producer, the schema, and both fixtures in
  one review.
- Security invariants are the list in [`SECURITY.md`](./SECURITY.md) and the
  Gotchas section of [`AGENTS.md`](./AGENTS.md), enforced by
  `tests/integration/agent-policy.test.ts` and the secret-ledger unit tests.

Where the docs and the code disagree, the code wins and the docs are a bug.
Fix the prose when you find it stale.

## Development workflow

This project is a pnpm monorepo. `packages/` holds what publishes to npm,
`apps/` the private apps and suites that consume the built packages:

- `packages/e2e`: the published `e2e` package (SDK, runner, CLI, engine contract)
- `packages/web`: the published `@e2e-dev/web` browser engine
- `packages/mobile`: the published `@e2e-dev/mobile` mobile engine
- `apps/testbed`: private dogfood suite that consumes the built packages
- `apps/web-benchmark`: private Next.js app of hard-surface scenarios plus the e2e suites written against them
- `apps/mobile-benchmark`: private Expo app of hard mobile surfaces plus the e2e suites written against them
- `docs/`: the docs site, built with [Mintlify](https://mintlify.com)
- `skills/e2e/`: the agent skill shipped with the package and installed by `e2e init`

Install dependencies from the root:

```sh
pnpm install
```

Build first; nearly everything downstream consumes `dist`:

```sh
pnpm build
```

Before sending a pull request, make sure the full gate passes:

```sh
pnpm check   # lint -> check:dead-code -> typecheck -> docs:check
pnpm test    # unit + integration
```

Integration tests need Chromium:

```sh
pnpm --filter @e2e-dev/web exec playwright install chromium
```

Docs are part of the change, not a follow-up. A behavior change updates its
page under `docs/` in the same review, and `skills/e2e/` when the
skill describes that surface.

```sh
pnpm docs:dev     # local preview
pnpm docs:check   # validate the site, its links, and the quickstart examples
```

A change that claims to be faster, or that touches the runner, the agent
loop, or an engine, gets measured against `main` on the benchmark suites:

```sh
pnpm bench:ab -- tests-agent/control-inventory.e2e.ts --config e2e.agent.config.ts
```

It prints a markdown table to paste into the PR, and lists first any test
whose behavior changed. `AGENTS.md` describes the output.

### Commit message convention

We follow the [conventional commits specification](https://www.conventionalcommits.org/en):

- `fix`: bug fixes, e.g. fix a crash when the engine disconnects.
- `feat`: new features, e.g. add a new assertion.
- `refactor`: code refactor with no behavior change.
- `docs`: documentation changes.
- `test`: adding or updating tests.
- `chore`: tooling changes, e.g. change CI config.

Mark a breaking change with `!` after the type (`feat(config)!: ...`). PRs are
squash-merged, so the PR title is the commit; the
[`writing-pr`](./.claude/skills/writing-pr/SKILL.md) skill describes the body,
including the `## Verified` section every PR carries. Coding agents open PRs
through the [`ship-pr`](./.claude/skills/ship-pr/SKILL.md) skill and babysit
them until the `Ready for Human Review` label is on; a later push removes it.

### Changesets

We use [changesets](https://github.com/changesets/changesets) to publish new
versions. It handles bumping the version based on semver, writing the
changelog, and creating tags and GitHub releases.

If your change affects `e2e`, `@e2e-dev/web`, or
`@e2e-dev/mobile`, add a changeset:

```sh
pnpm changeset
```

Changes limited to the apps (testbed, web benchmark, mobile benchmark), docs,
or CI don't need one. Everything under `apps/` is private and skipped entirely
(`privatePackages: false`), so none gets a version bump, a changelog, or a git
tag. Never hand-edit a package `version` or
`CHANGELOG.md`; `changesets/action` owns both.

## Releases

The runner publishes to npmjs as `e2e`; engines and reporters publish under
the `@e2e-dev` scope. All are public packages: anyone can install them and read
the release on GitHub. After a PR with a changeset lands on `main`, the release
workflow opens a `chore: version packages` pull request that applies the
pending changesets. That PR gets no CI of its own (it is opened with
`GITHUB_TOKEN`), so check `main` is green before merging it. Merging it checks
peer ranges, builds, publishes the new versions, and creates the matching
GitHub release. `@e2edev/e2e` is the
runner's retired name, and the `@e2edev` scope is the engines' and reporters'
retired scope; both are deprecated on npm.

### npm Trusted Publishing

The release workflow carries no npm token. Each package grants `release.yml`
publish rights through an npm trusted publisher (OIDC). Once the repository
is public, npm also attaches provenance automatically: the "built and signed
on GitHub Actions" badge on npmjs (skipped while the repository is private).
npm has no org-wide setting for this; every package is connected one by one.
The `release` job must stay on a GitHub-hosted runner: npm rejects OIDC
tokens from self-hosted runners, Blacksmith included.

When adding a new public package:

1. Publish the first version by hand from a maintainer machine. Trusted
   publishers live in package settings on npmjs, so the package has to exist
   before one can be added.
2. On npmjs.com open the package, then Settings, then Trusted Publisher:
   - Publisher: GitHub Actions
   - Organization: `tester-army`, Repository: `e2e`
   - Workflow filename: `release.yml`
   - Environment name: leave blank
   - Allowed actions: check `Allow npm publish`. Changesets publishes
     directly, not through npm's staged flow, so without it the publish is
     rejected. Leave `npm dist-tag` unchecked.
3. From then on the release workflow publishes every version. There is no
   `NPM_TOKEN` fallback: a package without this connection fails the publish
   step.

### Release channels

- `latest`: the current stable release. Install with no tag.
- `next`: release candidates cut from `main` ahead of a `latest` release.
  This is the build we ask reporters to confirm a fix against. Install with
  `@next`.
- `canary`: a build of `main` cut by hand ahead of the next versioned release.
  Install with `@canary`. The quickstart installs `latest`.

Versioned releases publish to `latest`: the root `release` script passes no
`--tag`, and each publishable package carries `publishConfig.tag: "latest"` as
a backstop for a hand-run `npm publish`. `next` is not cut yet.

A canary is a changesets snapshot release, published from a maintainer's
machine, never from CI:

```sh
GITHUB_TOKEN=<token> pnpm run canary
pnpm run canary:publish
git checkout -- packages .changeset
```

The first script writes a changeset that bumps every public package, versions
them as `<next version>-canary-<datetime>`, and builds. The second publishes
with `--tag canary`; it is a separate step because npm's two-factor prompt
(a hardware key, for instance) has to be answered at the terminal. Bumping all
of them together is what keeps the engines installable: their peer ranges are
rewritten to the runner's exact canary version, and `init` pins the engine
build it shipped with. The build has to run after versioning for that pin to
hold, and each build stamps `dist/.build.json` with its version; a
`prepublishOnly` hook in every package refuses to publish a `dist` whose stamp
does not match `package.json`, so a publish without the build step in front of
it fails instead of shipping the previous build. Nothing the scripts write is
committed.

## Stability policy

### What is covered

The following are the public contract. A change that breaks any of them is a
breaking change and follows the rules below:

- Public types exported from `e2e` and `e2e/engine`, as
  emitted in `dist/index.d.ts` and `dist/engine/index.d.ts`. Removing an
  export, narrowing an accepted input, widening a returned type, or changing a
  fixture's runtime behavior all count.
- Config keys in `e2e.config.ts`, their types, and their defaults.
- CLI commands, flags, exit codes, and environment variables (`E2E_*`).
- Wire formats: the report, session, and agent protocol schemas in
  `packages/e2e/schema/`, and the replay cache layout under `.e2e/cache/`.
  Adding an optional field is compatible; renaming, removing, or changing the
  meaning of one is not.

Not covered: anything under `internal`, the testbed, the exact text of error
messages and reporter output (error *codes* are covered), and the agent's
prompts and tool descriptions.

### Breaking changes

- A breaking change to a covered surface ships with a deprecation first. The
  old form keeps working, prints a one-line warning naming the replacement,
  and is documented as deprecated on its reference page and in the changelog.
- The window is six months. Deprecations are batched at the start of a
  window; the first window opens on October 1, 2026, so removals from that
  batch land no earlier than April 1, 2027. The next batch is April 1, and so
  on, twice a year.
- Removal happens at the end of the window, in a minor release while the
  packages are `0.x` (semver treats `0.x` minors as breaking) and in a major
  release from `1.0` onward. The changeset body names both the removed form
  and its replacement, and the PR title carries the `!`.
- A deprecation is announced in three places when it lands: the changeset
  (so it reaches the changelog and the GitHub release), the reference page
  for the surface, and a runtime warning the first time the old form is used
  in a run.
- Security fixes are the exception. If keeping the old form open is itself
  the vulnerability, it is removed in a patch and the advisory says so.

### Engine contract

`e2e/engine` is what `@e2e-dev/web` and `@e2e-dev/mobile`
build against, and what a third-party engine builds against too. A change to
that contract bumps all three packages together in one release, with a
changeset for each, so an engine and a runner from the same release always
match. Engines declare a peer range on `e2e` that points one way only
(engine to runner, `>=x <1`), and each integration (`@e2e-dev/kernel`, `@e2e-dev/testmuai`, `@e2e-dev/eas`) does
the same on the engines it plugs into; do not make it mutual or narrow it.
