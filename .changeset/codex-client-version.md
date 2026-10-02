---
'e2e': patch
---

`e2e models openai` asks the ChatGPT backend for its model list as Codex CLI 0.160.0 (was 0.155.1). The backend hides models from clients it considers too old, so models unlocked since 0.155.1 now show up and can be passed to `chatgpt()`.
