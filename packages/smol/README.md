# @e2e-dev/smol

[smol machines](https://smolmachines.com) browsers for [`e2e`](https://www.npmjs.com/package/e2e):
`web({ browser: smol() })` runs each test attempt in its own branch of a warm
Chromium microVM on your computer.

## Why choose it

Use `smol()` for stateful web tests that need a fresh browser for each attempt,
including retries. A warm browser is prepared once and then branched; with
`app`, each branch also gets its own running app and data stored in the VM.
This lets tests change files or a local database without carrying that state
into the next attempt. The machines run locally, without a hosted browser
account. External services are still shared between attempts.

## Install

```bash
npm install --save-dev @e2e-dev/smol smolmachines
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { smol } from '@e2e-dev/smol';

export default {
  targets: [
    {
      engine: web({ browser: smol({ hostPorts: [3000] }) }),
      app: { url: 'http://localhost:3000', command: { executable: 'npm', args: ['run', 'dev'] } },
    },
  ],
  workers: 4,
} satisfies E2EConfig;
```

Each worker slot boots one Chromium machine on the smol engine embedded in
`smolmachines` (macOS on Apple Silicon, or Linux with KVM). With the default
`scope: 'attempt'`, every attempt then gets a copy-on-write branch of that
running browser typically in about a second, depending on port readiness.
It has its own memory and disk and is deleted when the attempt ends.
`prepare(cdpEndpoint)` drives the warm browser once before it is branched, so
every attempt starts signed in. `hostPorts` lists the
ports on your computer's loopback the browser reaches as its own `localhost`.
These ports are not an access policy: the machine can also reach every host
loopback port through `host.smolvm.internal` and has outbound network access.
`setup` runs a shell script in the machine before Chromium starts.
`app: { source, setup, start, port }` runs the app under test inside the
machine instead of on your computer, so in `attempt` scope every attempt
also gets its own copy of the running app and the data it keeps on the machine.
`scope: 'worker'` keeps one browser machine per worker slot instead, shared by
the attempts on that slot.

Full documentation lives at [e2e.tester.army/docs/integrations/smol](https://e2e.tester.army/docs/integrations/smol).

## License

Apache-2.0
