# @e2edev/testerarmy

The [TesterArmy](https://tester.army) reporter for [`@e2edev/e2e`](https://www.npmjs.com/package/@e2edev/e2e).
Every finished run — the report and the screenshots, traces, and videos it
names — is uploaded to your TesterArmy project, and the run's URL prints under
the summary.

## Install

```bash
npm install --save-dev @e2edev/testerarmy
```

```ts title="e2e.config.ts"
import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';
import { testerarmy } from '@e2edev/testerarmy';

export default {
  targets: [{ engine: playwright({ url: 'http://localhost:3000' }) }],
  reporters: ['list', testerarmy()],
} satisfies E2EConfig;
```

Set `TESTERARMY_API_KEY` to a key from
[tester.army/dashboard/profile/api-keys](https://tester.army/dashboard/profile/api-keys),
or run `npx testerarmy auth` once: the reporter reads the key the CLI saved.
Without either, it uploads nothing and says so in one summary row, so the same
config works on a laptop without an account and in CI with the secret.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `project` | the key's default project | The TesterArmy project id the runs land in |
| `apiKey` | `'TESTERARMY_API_KEY'` | The name of the environment variable holding the key, never the key itself |

`TESTERARMY_BASE_URL` points the reporter at another host, as it does the CLI.
The key `testerarmy auth` saved is used for tester.army only; another host
needs the variable.

## What is uploaded

The report-1 document `e2e` writes to `.e2e/report.json`, and every artifact it
names that exists on disk: screenshots, Playwright traces, and, on an engine
that records, `--video` recordings. Artifacts travel by content digest, so bytes
TesterArmy already holds are not sent again. A Playwright trace records what the page showed,
including fields a test filled; upload only to a project whose members may see
that. The reporter runs after the summary, within the runner's reporter
budget, and never changes the run's exit code: a failed upload is one line on
stderr.

## License

MIT
