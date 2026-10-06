---
"e2e": patch
---

A credential whose `username` is not a string, or with a key other than `username` and `password`, fails the config load with `INVALID_CONFIG` naming the field, instead of a raw "value of type function is not JSON-safe" error. Only `password` may be a function. A credential with no username in the config or `E2E_USER_<NAME>_USERNAME` is `INVALID_CONFIG` too.
