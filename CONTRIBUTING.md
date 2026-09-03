# Contributing

Contributions are always welcome, no matter how large or small.

## Development workflow

This project is a pnpm monorepo containing:

- `packages/e2e` — the published `@e2edev/e2e` package (SDK, runner, CLI, driver SPI)
- `packages/playwright` — the published `@e2edev/playwright` reference web driver
- `packages/testbed` — private dogfood suite that consumes the built packages
- `spec/` — the normative contract, `fern/` — the docs site

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
pnpm check   # lint -> check:spec -> typecheck -> docs:check
pnpm test    # unit + integration
```

Integration tests need Chromium:

```sh
pnpm --filter @e2edev/playwright exec playwright install chromium
```

`spec/` is a frozen normative contract and stays internal: it defines profiles
(`spec/00-conformance.md`), canonical declarations (`spec/api/`), wire schemas
(`spec/schema/`), and mandatory safety behavior (`spec/14-security.md`). A spec
change touches declarations, schemas, prose, examples, and tests in one review —
implementation shortcuts never amend the spec. READMEs and the docs site describe
user-facing behavior only; profile IDs, schema versions, and conformance status
belong in `spec/`.

Editing `spec/conformance/v0-requirements.json` or any `spec/schema/*` file also
requires bumping `suiteVersion` in the manifest, because implementations key
their conformance reports to it. CI enforces the coupling; check it locally with:

```sh
pnpm check:manifest   # compares the working tree against origin/main
```

Docs are part of the change, not a follow-up: a behavior change updates its guide
page under `fern/` in the same review.

```sh
pnpm docs:dev     # local preview
pnpm docs:check   # validate configuration and pages
```

### Commit message convention

We follow the [conventional commits specification](https://www.conventionalcommits.org/en):

- `fix`: bug fixes, e.g. fix a crash when the driver disconnects.
- `feat`: new features, e.g. add a new assertion.
- `refactor`: code refactor with no behavior change.
- `docs`: documentation changes.
- `test`: adding or updating tests.
- `chore`: tooling changes, e.g. change CI config.

### Changesets

We use [changesets](https://github.com/changesets/changesets) to publish new
versions. It handles bumping the version based on semver, writing the
changelog, and creating tags and GitHub releases.

If your change affects `@e2edev/e2e` or `@e2edev/playwright`, add a changeset:

```sh
pnpm changeset
```

Changes limited to the testbed, docs, or CI don't need one. `@e2edev/testbed` is
private and skipped entirely (`privatePackages: false`), so it never gets a
version bump, a changelog, or a git tag.

### Publishing to npm

The packages are in a private phase: all three publish to npmjs under the
`@e2edev` organization scope with `publishConfig.access: "restricted"`, so
only members of the org (and tokens scoped to it) can install them. Provenance
is off because npm only issues attestations for public packages. The release
workflow authenticates with the `NPM_TOKEN` repository secret, which must be a
granular access token with read/write on the `@e2edev` scope (packages and
scopes, not just a single package, so a first publish of a new package works).
To publish by hand, `npm login` as an org member and run `pnpm run release`.
The `e2e` CLI binary keeps its unscoped name; the unscoped `e2e` package on
npmjs is unrelated, so consumers must run it as `npx --no-install e2e`.

Everything ships to the `beta` dist-tag while the surface stabilizes, so npm's
`latest` is not moved. The root `release` script passes `--tag beta`, and both
publishable packages also carry `publishConfig.tag: "beta"`. The flag is what
actually decides the channel — `changeset publish` always forwards `--tag` to the
publish tool, and `pnpm publish` ignores `publishConfig.tag` — so the manifest
field is a backstop for a hand-run `npm publish`, and a record of intent that
travels with the package.

Two caveats worth knowing:

- npmjs auto-assigns `latest` on a package's **first** publish, in addition to
  the tag you ask for. A brand-new package therefore lands on `latest` once no
  matter what, and `latest` can only be moved afterwards, never removed.
- Versions stay plain 0.x. Changesets pre mode is deliberately unused: a
  prerelease version falls outside the driver's `@e2edev/e2e` peer range, forcing a major
  bump of `@e2edev/playwright` on every runner minor. Widening the range does not
  help — node-semver only lets a prerelease satisfy a comparator set when some
  comparator with the same `major.minor.patch` also carries a prerelease, so
  `0.3.0-beta.0` satisfies neither `>=0.1.0-0 <1` nor `*`.

After a PR with a changeset lands on `main`, the release workflow opens a
`chore: version packages` pull request that applies the pending changesets.
Merging that PR runs `pnpm check`, publishes the new versions to npm with
provenance, and creates the matching GitHub release.

Going stable later: drop `--tag beta` from the root `release` script and the
`tag` field from each package's `publishConfig`.
