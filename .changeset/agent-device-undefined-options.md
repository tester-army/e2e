---
"@e2edev/agent-device": patch
---

Every optional `agentDevice()` option (`app`, `appPath`, `device`, `identity`,
`environment`, `session`, `snapshot`) also accepts `undefined`, so a config
passes `device: process.env.E2E_DEVICE` straight through instead of spreading
it in conditionally. The runtime already treated a missing and an `undefined`
value alike; only the types rejected the latter under
`exactOptionalPropertyTypes`.
