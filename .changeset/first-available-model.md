---
"e2e": patch
---

Add `firstAvailable([{ env, model }, ...])`. It returns the first model whose named environment variable is set when the config loads. With none set it raises `MODEL_UNAVAILABLE` and names every variable, never a value. A model it returns is part of the replay cache key. Other configs keep their existing keys.
