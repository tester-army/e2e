---
'e2e': patch
---

OpenAI and Azure OpenAI requests carry `store: false` unless `providerOptions` sets it. The runner never reads a response back from the provider, and with storage on the AI SDK replayed a reasoning model's earlier turns by item id, so an organization with zero data retention, where nothing is stored, failed the second turn of every `act` step with `Item with id 'rs_…' not found`. Reasoning now travels inline as encrypted content, the prompt cache keeps working, and that failure names its remedy when a caller turns storage back on.
