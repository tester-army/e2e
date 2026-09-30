---
'e2e': patch
---

The bundled skill (`e2e init`, `e2e guide`) shows the current config shape: its first `e2e.config.ts` and the setup example declare the app on the target, `targets: [{ engine: web(), app: { url, command } }]`, instead of the removed `web({ url, command })`, which fails at config load with `INVALID_CONFIG`.
