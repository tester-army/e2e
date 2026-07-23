# Roadmap — Pull Request Testing

> **Status: roadmap.** Not part of the v0 spec. This draft predates several
> core-API changes and will be re-validated before adoption.

PR testing is a first-class primitive, not GitHub Actions glue. The SDK
exposes PR metadata as a resource and supports three modes: static tests on
a preview URL, selective test runs based on changed files, and exploratory
dynamic tests.

## `pr` — PR context resource

```ts
import { test, expect, pr } from 'e2e';
```

### `pr.context()`

```ts
type PullRequestContext = {
  provider: 'github' | 'gitlab' | 'local';
  repo: string;
  owner: string;
  number: number;
  title: string;
  body?: string;
  branch: string;
  baseBranch: string;
  sha: string;
  changedFiles: string[];
  diff: string;
  previewUrl?: string;
  labels: string[];
};

pr.context(): Promise<PullRequestContext>;
```

Detection: reads CI provider env (GitHub Actions first), fetches diff/files
via `GITHUB_TOKEN` when available, falls back to local `git` against
`baseBranch`. Outside a PR, `pr.context()` rejects with a helpful error
(`test.dynamic` tests are then skipped, not failed).

### Convenience accessors

```ts
pr.previewUrl(options?: PreviewUrlOptions): Promise<string>;
pr.changedFiles(): Promise<string[]>;
pr.diff(): Promise<string>;
```

### Preview URL resolution

```ts
type PreviewUrlOptions = {
  providers?: Array<'vercel' | 'netlify' | 'render' | 'railway'>;
  fallbackEnv?: string[]; // default ['E2E_PREVIEW_URL', 'VERCEL_URL']
};
```

Priority order:

1. `E2E_PREVIEW_URL` env var
2. Explicit `pr.previewUrl` in config
3. Vercel deployment for the PR sha (GitHub deployments/checks API)
4. Netlify / Render / Railway env conventions
5. GitHub deployment status
6. Fail with an actionable error listing what was checked

## Mode 1 — static tests on preview URL (v0)

Nothing new to learn; the preview URL is just the base URL:

```ts
export default test('checkout still works', async ({ app, agent }) => {
  await app.open(await pr.previewUrl());

  await agent.act('buy the pro plan');
  await agent.assert('the checkout succeeds');
});
```

## Mode 2 — selective runs on changed files

Config-level mapping from path globs to test tags/files. Deterministic
speedup, no agent involved in selection:

```ts
// e2e.config.ts
export default defineConfig({
  pr: {
    selectTests: {
      'app/billing/**': ['checkout', 'stripe-webhook'],
      'app/integrations/slack/**': ['slack-notification'],
      'app/auth/**': ['signup', 'password-reset'],
    },
  },
});
```

- Keys: path globs matched against `pr.changedFiles()`.
- Values: test tags or test file paths.
- `npx e2e pr` runs the union of matched tests; unmatched changes run the
  `pr.fallback` set (default: all tests tagged `smoke`).

## Mode 3 — exploratory dynamic tests

`test.dynamic()` marks a test as agent-driven and non-deterministic. It gets
the `pr` fixture bound automatically:

```ts
export default test.dynamic('changed user flows still work', async ({ app, agent, pr }) => {
  await app.open(pr.previewUrl);

  await agent.act('test the user-facing flows affected by this pull request', {
    title: pr.title,
    body: pr.body,
    diff: pr.diff,
    changedFiles: pr.changedFiles,
  });

  await agent.assert('the changed flows work without visible regressions');
});
```

Semantics of `test.dynamic`:

- Inside `test.dynamic`, the `pr` fixture is the **resolved**
  `PullRequestContext` (already awaited; properties, not promises).
- Skipped (not failed) when no PR context exists.
- Reported separately from static tests: results are advisory by default
  (`pr.dynamic.blocking: false` in config), so agent judgment doesn't flake
  merges until teams opt in.
- The agent may consult: PR title/body, diff, changed files, route map,
  existing test titles, prior failures, and running service emulators.

## Per-PR service sandboxes (Cloud)

```ts
export default defineConfig({
  runner: 'cloud',
  resources: {
    stripe: 'managed-per-pr',
    slack: 'managed-per-pr',
    email: 'managed-per-pr',
  },
});
```

Each PR gets isolated hosted sandboxes; env for the preview deployment is
injected automatically.

## GitHub Check output

Users never write reporting code. When `GITHUB_TOKEN` is present, `npx e2e pr`
posts a check automatically:

- OSS: pass/fail check + summary comment, local artifacts uploaded as
  workflow artifacts.
- Cloud: rich check with video/trace links, per-file annotations, and an AI
  summary of what broke.

Programmatic surface (advanced, `e2e/github`):

```ts
import { github } from 'e2e/github';

await github.check({
  name: 'e2e',
  conclusion: 'failure',
  summary: 'Checkout regression detected',
  annotations: [{ path: 'app/billing/checkout.tsx', message: '…' }],
});
```

## CLI

```bash
npx e2e pr
```

Does, in order: detect CI provider → resolve PR metadata → resolve preview
URL → select static tests (Mode 2 config) → run them → run `test.dynamic`
tests → collect artifacts → post GitHub Check.

## GitHub Actions

OSS:

```yaml
name: e2e
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx e2e pr
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          E2E_PREVIEW_URL: ${{ steps.preview.outputs.url }}
```

Cloud:

```yaml
      - run: npx e2e pr --cloud
        env:
          TESTERARMY_TOKEN: ${{ secrets.TESTERARMY_TOKEN }}
```

Roadmap: `uses: testerarmy/pr-check@v1` wrapping the above.
