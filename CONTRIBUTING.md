# Contributing

Contributions are welcome, no matter how large or small. Bug reports and docs
fixes count as much as features.

## License and contribution terms

The code is MIT (see [`LICENSE`](./LICENSE)). There is no CLA and no DCO bot.
By opening a pull request you agree that your contribution is licensed under
the same MIT terms as the project (inbound = outbound). Only submit work you
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

This project is a pnpm monorepo containing:

- `packages/e2e`: the published `@e2edev/e2e` package (SDK, runner, CLI, engine contract)
- `packages/playwright`: the published `@e2edev/playwright` browser engine
- `packages/agent-device`: the published `@e2edev/agent-device` mobile engine
- `packages/testbed`: private dogfood suite that consumes the built packages
- `packages/web-benchmark`: private Next.js app of hard-surface scenarios plus the e2e suites written against them
- `docs/`: the docs site, built with [Starlight](https://starlight.astro.build)
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
pnpm --filter @e2edev/playwright exec playwright install chromium
```

Docs are part of the change, not a follow-up. A behavior change updates its
page under `docs/src/content/docs/` in the same review, and `skills/e2e/` when the
skill describes that surface.

```sh
pnpm docs:dev     # local preview
pnpm docs:check   # build the site and validate every link and anchor
```

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
[`writing-pr`](./.claude/skills/writing-pr/SKILL.md) skill describes the body.

### Changesets

We use [changesets](https://github.com/changesets/changesets) to publish new
versions. It handles bumping the version based on semver, writing the
changelog, and creating tags and GitHub releases.

If your change affects `@e2edev/e2e`, `@e2edev/playwright`, or
`@e2edev/agent-device`, add a changeset:

```sh
pnpm changeset
```

Changes limited to the testbed, the web benchmark, docs, or CI don't need one.
`@e2edev/testbed` and `@e2edev/web-benchmark` are private and skipped entirely
(`privatePackages: false`), so they never get a version bump, a changelog, or a
git tag. Never hand-edit a package `version` or
`CHANGELOG.md`; `changesets/action` owns both.

## Releases

Packages publish to npmjs under the `@e2edev` scope as public packages;
anyone can install them and read the release on GitHub. After a PR with a
changeset lands on `main`, the release workflow opens a `chore: version
packages` pull request that applies the pending changesets. Merging that PR
re-runs the full gate, publishes the new versions, and creates the matching
GitHub release. The `e2e` CLI binary keeps its unscoped name; the unscoped
`e2e` package on npmjs is a placeholder the team reserved, so run it as
`npx --no-install e2e`.

### Release channels

- `latest`: the current stable release. Install with no tag.
- `next`: release candidates cut from `main` ahead of a `latest` release.
  This is the build we ask reporters to confirm a fix against. Install with
  `@next`.

While the packages are `0.x`, everything ships to the `beta` dist-tag instead
and `latest` is not moved. The root `release` script passes `--tag beta`, and
each publishable package carries `publishConfig.tag: "beta"` as a backstop for
a hand-run `npm publish`. Switching to `latest` plus `next` is a two-line change
in that script and those manifests, and happens with `1.0`.

Versions stay plain `0.x` until then. Changesets pre mode is deliberately
unused: a prerelease version falls outside the engines' `@e2edev/e2e` peer
range, forcing a major bump of every engine on every runner minor. Widening the
range does not help; node-semver only lets a prerelease satisfy a comparator
set when a comparator with the same `major.minor.patch` also carries a
prerelease.

## Stability policy

### What is covered

The following are the public contract. A change that breaks any of them is a
breaking change and follows the rules below:

- Public types exported from `@e2edev/e2e` and `@e2edev/e2e/engine`, as
  emitted in `dist/index.d.ts` and `dist/engine/index.d.ts`. Removing an
  export, narrowing an accepted input, widening a returned type, or changing a
  fixture's runtime behavior all count.
- Config keys in `e2e.config.ts`, their types, and their defaults.
- CLI commands, flags, exit codes, and environment variables (`E2E_*`).
- Wire formats: the report, session, and agent protocol schemas in
  `packages/e2e/schema/`, and the trace cache layout under `.e2e/cache/`.
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

`@e2edev/e2e/engine` is what `@e2edev/playwright` and `@e2edev/agent-device`
build against, and what a third-party engine builds against too. A change to
that contract bumps all three packages together in one release, with a
changeset for each, so an engine and a runner from the same release always
match. Engines declare a peer range on `@e2edev/e2e` that points one way only
(engine to runner, `>=x <1`); do not make it mutual or narrow it.
