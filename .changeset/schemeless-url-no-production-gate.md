---
'@e2edev/e2e': minor
---

`app.url` and `APP_URL` no longer need a scheme: `tester.army` becomes `https://tester.army` and `localhost:3000` becomes `http://localhost:3000`. The `allowProduction` gate is gone and `app.environment` is no longer required for non-loopback hosts; it defaults to `test` for loopback, `.localhost`, and `.test` hosts and to `production` elsewhere, and stays a label for the report and the cache identity. `allowProduction` is now an unknown app key (`INVALID_CONFIG`), and the report target no longer carries it. `e2e init` now scaffolds a two-key config: `app: { url: 'localhost:3000' }` and one playwright web target; the built-in agent is used until you pass your own.
