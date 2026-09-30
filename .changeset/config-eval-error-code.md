---
'e2e': patch
---

A configuration error the config raises while it evaluates keeps its own code: an option `web()` or `mobile()` refuses, such as the renamed `web({ video })`, fails with `INVALID_CONFIG` and its message, as the docs say, instead of `CONFIG_LOAD_FAILED`. A failed import is still `CONFIG_LOAD_FAILED`.
