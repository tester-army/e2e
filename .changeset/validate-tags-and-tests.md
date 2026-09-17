---
'e2e': patch
---

Malformed selection input fails where it is written, instead of selecting nothing or failing as a test:

- `tags` must be a list of distinct names without spaces or commas, checked at registration (`COLLECTION_ERROR`). A bare string such as `tags: 'smoke'` was read letter by letter, so `--tag smoke` never selected the test.
- `tests` in the config must be a glob or a list of globs, each compiled at config resolution. A wrong type or a malformed glob is now `INVALID_CONFIG` or `INVALID_GLOB` (exit 2) for every command that loads the config, where before it reached collection as a plain TypeError and exited 1 as a test failure.
