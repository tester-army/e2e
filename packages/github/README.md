# @e2e-dev/github

The GitHub reporter for [`e2e`](https://www.npmjs.com/package/e2e).
From GitHub Actions, every run becomes one pull request comment, edited in
place on reruns, and the same text lands in the job summary.

```bash
npm install --save-dev @e2e-dev/github
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { github } from '@e2e-dev/github';

export default {
  targets: [{ engine: web({ url: 'http://localhost:3000' }) }],
  reporters: ['list', github()],
} satisfies E2EConfig;
```

The job needs `permissions: pull-requests: write` and the step that runs
`e2e` needs `GITHUB_TOKEN: ${{ github.token }}` in its `env`. Matrix replicas
of one job pass a `key` so their comments stay apart. When the reporter cannot
post (another CI, a push, a fork's read-only token) it says why in one summary
row and never changes the run's exit code.

Full documentation lives at [e2e.tester.army/docs/github](https://e2e.tester.army/docs/github).

## License

Apache-2.0
