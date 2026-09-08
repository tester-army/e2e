---
"@e2edev/e2e": minor
---

Judgments work on reasoning models. The judgment output cap is 8192 tokens
so hidden reasoning no longer eats the answer, `agent.assert` has two model
calls so a malformed response gets one repair round, and the adapter no
longer pins `temperature: 0`, which reasoning models reject. A new
`agent.providerOptions` config key sends AI SDK provider options (a reasoning
effort, a thinking budget) with every model call of both the `act` and the
judgment tiers.
