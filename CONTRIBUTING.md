# Contributing

Contributions are always welcome, no matter how large or small.

## Development workflow

This project is a pnpm monorepo containing:

- `packages/e2e` — the published `e2e` package (SDK, runner, CLI, driver SPI)
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

If your change affects `e2e` or `@e2edev/playwright`, add a changeset:

```sh
pnpm changeset
```

Changes limited to the testbed, docs, or CI don't need one.

### Publishing to npm

The root `release` script publishes with `--tag beta`, so releases land on the
`beta` dist-tag and npm's `latest` is never moved while the surface stabilizes.
Versions themselves stay plain 0.x — changesets pre mode is deliberately not
used, because a prerelease version falls outside the driver's `e2e` peer range
and would force a major bump of `@e2edev/playwright` on every runner minor.
Note `publishConfig.tag` is not enough on its own: `pnpm publish` ignores it.

After a PR with a changeset lands on `main`, the release workflow opens a
`chore: version packages` pull request that applies the pending changesets.
Merging that PR runs `pnpm check`, publishes the new versions to npm with
provenance, and creates the matching GitHub release.

Going stable later is one step: drop `--tag beta` from the root `release`
script.
