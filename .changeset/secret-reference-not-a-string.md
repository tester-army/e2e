---
'e2e': patch
---

A `secrets.get()` reference turned into a string while `e2e.config.ts` evaluates (a template literal, `String()`, `+`, `JSON.stringify`) fails with `INVALID_CONFIG` explaining that only an engine option that declares secrets accepts one. Before, `agents.default.context: 'key ' + secrets.get('API_KEY')` held `[object Object]`. A `command` or service `args` entry or `env` value that is not a string is `INVALID_CONFIG` too, naming a `secrets.get()` handle as one: `env: { API_KEY: secrets.get('API_KEY') }` started the app with `API_KEY=[object Object]`.
