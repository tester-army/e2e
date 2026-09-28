---
"@e2e-dev/integrations": minor
---

`@e2e-dev/integrations`, the home of official integrations with hosted services, one subpath each. The first is `@e2e-dev/integrations/kernel`: `web({ browser: kernel() })` runs a target in Kernel's hosted Chromium, one browser per worker slot, or per attempt with `scope: 'attempt'`. `kernel(options)` takes Kernel's create-browser body as is, reads `KERNEL_API_KEY` from the run's environment, tags every browser with the run, target, and slot, defaults `timeout_seconds` to 600 so Kernel deletes a browser a dead worker never released, and logs each browser's live view URL. `@onkernel/sdk` and `@e2e-dev/web` are optional peers.
