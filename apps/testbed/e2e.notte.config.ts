import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { notte } from '@e2e-dev/notte';
import base from './e2e.config.ts';

/**
 * The local suite on Notte cloud browsers, run by hand. The browser runs in
 * Notte's cloud, so the playground must be reachable from there: start it
 * (`pnpm app`), expose it through a tunnel, and pass the tunnel's URL.
 *
 *   NOTTE_API_KEY=... E2E_NOTTE_APP_URL=https://<tunnel> pnpm --filter @e2e-dev/testbed test:notte
 */
const url = process.env['E2E_NOTTE_APP_URL'];
if (url === undefined || url === '') throw new Error('Set E2E_NOTTE_APP_URL to a public URL that serves the playground (a tunnel to `pnpm app`)');

export default {
  ...base,
  filters: [],
  targets: base.targets.map((target) => ({ ...target, name: 'notte', engine: web({ browser: notte() }), app: { url } })),
} satisfies E2EConfig;
