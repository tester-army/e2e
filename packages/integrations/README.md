# @e2e-dev/integrations

Official integrations for [`e2e`](https://www.npmjs.com/package/e2e): hosted
services behind the engines' provider seams. Each integration is its own
subpath, and only that subpath imports the vendor's SDK, so you install the
SDK of the service you use and nothing else.

- `@e2e-dev/integrations/kernel`: [Kernel](https://kernel.sh) hosted browsers
  for the web engine, `web({ browser: kernel() })`.

## Kernel

```bash
npm install --save-dev @e2e-dev/integrations @onkernel/sdk
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { kernel } from '@e2e-dev/integrations/kernel';

export default {
  targets: [{ engine: web({ url: 'https://staging.example.com', browser: kernel({ stealth: true }), viewport: null }) }],
  workers: 4,
} satisfies E2EConfig;
```

`KERNEL_API_KEY` comes from the run's environment. `kernel(options)` takes
Kernel's create-browser body as is (`stealth`, `headless`, `timeout_seconds`,
`profile`, `proxy_id`, `viewport`, `tags`, ...) plus the lease `scope`:
`worker` (default) is one browser per worker slot for the run, `attempt` a
fresh browser per test attempt. Every browser is tagged with the run, target,
and slot, `timeout_seconds` defaults to 600 so Kernel deletes a browser a dead
worker never released, and each lease logs its live view URL.

Full documentation lives at [e2e.tester.army/docs/integrations/kernel](https://e2e.tester.army/docs/integrations/kernel).

## License

Apache-2.0
