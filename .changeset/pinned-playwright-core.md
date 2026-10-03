---
"@e2e-dev/web": minor
"e2e": patch
---

Breaking: `@e2e-dev/web` depends on `playwright-core` pinned to an exact version instead of peering on `playwright`. Projects no longer install Playwright themselves, and the engine always runs the Playwright it was tested against. Remove `playwright` from your dependencies unless your app uses it for its own tests:

```bash
npm uninstall playwright
```

Install browsers in CI with the package's new command, which runs the engine's Playwright: `npx @e2e-dev/web install chromium --with-deps` (`pnpm exec e2e-web install chromium --with-deps` under pnpm) replaces `npx playwright install chromium --with-deps`. Open traces with `npx playwright-core@1.63.0 show-trace <file>` (`pnpm dlx` in a pnpm project). An app that also depends on `@playwright/test` keeps its own copy; the two share a browser cache only when their versions match. `e2e init` no longer adds `playwright` to a new project.
