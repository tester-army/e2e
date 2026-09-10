# @e2edev/github

The GitHub reporter for [`@e2edev/e2e`](https://www.npmjs.com/package/@e2edev/e2e).
From GitHub Actions, every run becomes one pull request comment, edited in
place on reruns, and the same text lands in the job summary.

## Install

```bash
npm install --save-dev @e2edev/github
```

```ts title="e2e.config.ts"
import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';
import { github } from '@e2edev/github';

export default {
  targets: [{ engine: playwright({ url: 'http://localhost:3000' }) }],
  reporters: ['list', github()],
} satisfies E2EConfig;
```

The job needs permission to comment and the step needs the token:

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - run: npx --no-install e2e run
    env:
      GITHUB_TOKEN: ${{ github.token }}
```

## What the comment holds

The counts, the run-level errors, a table of every test that did not simply
pass (its error, the screenshots, traces, and recordings it left, a link to
its source at the pull request's head), the passed tests folded away, and a
link to the workflow run, where `actions/upload-artifact` put the evidence.
The comment carries a hidden marker per workflow and job, so a rerun edits
the previous comment instead of adding one. Matrix replicas of one job need a
`key` to tell their comments apart: `github({ key: process.env.MATRIX_BROWSER })`.

## When nothing is posted

The reporter says why in one summary row and never changes the run's exit
code: off GitHub Actions, on an event that is not a pull request (the job
summary is still written), without `GITHUB_TOKEN`, or on a pull request from
a fork, whose token is read-only. To post from another CI, or as an identity
that is not the workflow, use the TesterArmy reporter, `@e2edev/testerarmy`.

## License

MIT
