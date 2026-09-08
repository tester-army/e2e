---
"@e2edev/e2e": patch
---

`E2E_MODEL_ENDPOINT` sets the model endpoint from the environment. It takes the
same URL rules as `agent.model.endpoint` (HTTPS unless loopback), the config
value wins over it, and the AI Gateway stays the default, so a run against any
OpenAI-compatible endpoint needs only `E2E_MODEL`, `E2E_MODEL_ENDPOINT`, and
`E2E_MODEL_API_KEY`.
