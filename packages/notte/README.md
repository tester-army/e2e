# @e2e-dev/notte

[Notte](https://notte.cc) cloud browsers for [`e2e`](https://www.npmjs.com/package/e2e):
`web({ browser: notte() })` runs a web target in Notte's hosted browser sessions.

## Install

```bash
npm install --save-dev @e2e-dev/notte notte-sdk
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { notte } from '@e2e-dev/notte';

export default {
  targets: [{ engine: web({ browser: notte({ solve_captchas: true }) }), app: { url: 'https://staging.example.com' } }],
  workers: 4,
} satisfies E2EConfig;
```

`NOTTE_API_KEY` comes from the run's environment, and `NOTTE_API_URL` when
set. `notte(options)` takes Notte's start-session body as is
(`solve_captchas`, `proxies`, `browser_type`, `idle_timeout_minutes`,
`max_duration_minutes`, `viewport_width`, `viewport_height`, `profile`, ...).
Each test attempt gets a fresh session, stopped when the attempt ends; a
Notte session refuses new browser contexts, so the provider leases in
`attempt` scope only. Notte closes a session a dead worker left after
`idle_timeout_minutes`.

Full documentation lives at [e2e.com/docs/integrations/notte](https://e2e.com/docs/integrations/notte).

## License

Apache-2.0
