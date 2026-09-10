---
'@e2edev/e2e': patch
---

`e2e init` lists the engines as Web (Playwright), Mobile (iOS/Android) with agent-device, and None last. Its closing `next:` line and the skipped-skill hint run the CLI through the project's package manager (`npm run test:e2e`, `pnpm exec e2e guide`) instead of `npx --no-install`. The CLI, README, and skill link to the docs at https://e2e.mintlify.app; the Vercel-hosted address returns 404.
