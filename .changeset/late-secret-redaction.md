---
"e2e": patch
---

Step records and app logs are rechecked against provider-backed secrets when they are returned or written. Long text is redacted before it is shortened, or omitted when it cannot be safely redacted.
