---
'e2e': patch
---

`e2e doctor --model <provider>/<model-id>` checks a subscription model without a config entry using its provider credential—the stored login, or `OPENCODE_API_KEY` for OpenCode Console—and makes one call with `--check-model`. Named models are checked even when the config fails to load.
