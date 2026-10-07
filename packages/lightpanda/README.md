# @e2e-dev/lightpanda

[Lightpanda](https://lightpanda.io), the open-source headless browser, for
[`e2e`](https://www.npmjs.com/package/e2e): `web({ browser: lightpanda() })`
runs a web target in a `lightpanda serve` the provider starts for each
worker slot and stops with the run.

## Install

```bash
npm install --save-dev @e2e-dev/lightpanda
brew install lightpanda-io/browser/lightpanda
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { lightpanda } from '@e2e-dev/lightpanda';

export default {
  targets: [{ engine: web({ browser: lightpanda({ loadResources: ['iframe'] }) }), app: { url: 'http://localhost:3000' } }],
  workers: 4,
} satisfies E2EConfig;
```

The binary comes from `binary`, `LIGHTPANDA_PATH` in the run's environment,
or `lightpanda` on `PATH`. `endpoint`, or `LIGHTPANDA_URL`, attaches every
worker to a server already running (the Docker image in CI) instead, and
release leaves it alone. `loadResources` passes `--load-resources` for
`iframe`, `image`, and `stylesheet`; `args` adds any other `serve` flag.

Lightpanda has no layout engine: locators, assertions, and agent steps on
the accessibility tree work, while drags, dialogs, downloads, scrolling,
and session restore do not. The full list lives at
[e2e.tester.army/docs/integrations/lightpanda](https://e2e.tester.army/docs/integrations/lightpanda).

## License

Apache-2.0
