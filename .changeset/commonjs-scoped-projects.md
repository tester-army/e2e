---
'@e2edev/e2e': patch
---

`e2e run` loads `.ts` config, tests, and helpers as ES modules whatever the nearest `package.json` says. A Next.js app, or any other package without `"type": "module"`, no longer has to change its module type (which also changes how its `.js` files run), and `init` stops asking for it. `.cts` files and dependencies keep their own format.

`init` writes the engine version released alongside the CLI (`^0.7.0` for `@e2edev/playwright`) instead of `0.x`. Package managers resolve a range to the registry's `latest` tag whenever it satisfies, and `latest` trails the tag the runner installs from, so `0.x` fetched an old engine whose peer range rejected the runner.
