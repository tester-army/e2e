---
"e2e": patch
---

Find `e2e.config.js` and `e2e.config.mjs` as well as `e2e.config.ts` and `e2e.config.mts`, so a project written in plain JavaScript needs no `--config` flag. A TypeScript config still wins in its directory, so the `e2e.config.js` that `tsc` emits beside it is ignored. `e2e init` leaves an existing JavaScript config alone and writes its example test as `tests/example.e2e.js`, and a run that finds only `*.e2e.js` files names the `tests` glob to set. The quickstart shows the JavaScript setup, and the [config reference](https://e2e.tester.army/docs/reference/config#javascript) the details.
