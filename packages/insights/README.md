# @e2e-dev/insights

Run history for [`e2e`](https://www.npmjs.com/package/e2e). It finds the
flaky and broken tests across runs, the tests that keep missing the replay
cache, and the ones that cost the most model tokens.

```bash
npm install --save-dev @e2e-dev/insights
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { insights, quarantineFilter } from '@e2e-dev/insights';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  reporters: ['list', insights()],
  filters: [quarantineFilter()], // report mode: names flaky tests, leaves them in
} satisfies E2EConfig;
```

```bash
npx e2e-insights                                  # terminal tables
npx e2e-insights --format html --out insights.html
npx e2e-insights --format markdown >> "$GITHUB_STEP_SUMMARY"
```

Guide: [Run history and flaky tests](https://e2e.com/docs/insights).
