---
"e2e": minor
---

Subscription sign-in ships inside `e2e`; the separate `@e2edev/oauth` package is gone. Import the model from `e2e/oauth/chatgpt`, `e2e/oauth/copilot`, or `e2e/oauth/grok` and install only the provider package it wraps (`@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/xai`); the flows, the credential stores, and `createOAuthFetch` are on `e2e/oauth`. `e2e init` writes those imports and no longer adds a sibling dependency, `e2e login` and `e2e logout` run the flows directly, and the `e2e-oauth` bin is retired; uninstall `@e2edev/oauth` from projects that had it. The `chatgpt()` fold for the Codex stream without a `content-type` header lands with it.

`e2e models [provider]` asks the vendor which models a stored login serves and prints their ids. `chatgpt()` now tells the AI SDK that the Codex backend stores nothing server side, so a second turn carries the encrypted reasoning of the first instead of referring to it by an id the backend cannot find (`Item with id 'rs_…' not found`). The `CHATGPT_MODELS` constant is gone; the list is the vendor's.
