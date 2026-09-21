---
'@e2edev/oauth': patch
---

`chatgpt()` models work again. The Codex backend now answers its Responses stream with no `content-type` header, so the stream reached the AI SDK unfolded and every call failed with `MODEL_PROVIDER_FAILED: Invalid JSON response`; it also sends the final event with an empty `output`. The fold recognizes the stream by its body and assembles the output from the streamed items.
