# @e2e-dev/html-reporter

The HTML reporter for [e2e](https://e2e.tester.army). At the end of a run it
writes `.e2e/report.html`: one page that opens from disk with no server. It
lists the tests by file, with status tabs and a search box. Each test's page
shows its attempts, error, steps, screenshots, and video, and each step links
to its moment in the video.

```bash
npm install --save-dev @e2e-dev/html-reporter
```

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { htmlReporter } from '@e2e-dev/html-reporter';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  reporters: ['list', htmlReporter()],
} satisfies E2EConfig;
```

By default the page links screenshots and videos from `.e2e/results/`, so
keep the output directory together when you upload it from CI. `media`
changes that: `htmlReporter({ media: 'embed' })` puts them in the page, so
the one file is the whole report, and `media: 'none'` leaves them out for a
small, text-only page. `outputFile` writes the page somewhere else, as a path
from the project root.

## Development

The page is a React app in `app/`, built by Vite into one HTML file
(`dist/app/index.html`) with its scripts, styles, and fonts inlined. The
reporter fills that file's payload placeholder with the run's report.

```bash
pnpm --filter @e2e-dev/html-reporter run build
pnpm --filter @e2e-dev/html-reporter run test
```

The page uses the e2e design system's tokens (`app/styles.css`), with Geist
and JetBrains Mono, both under the SIL Open Font License 1.1.
