---
'e2e': patch
---

Malformed selection input fails where it is written, with the file named:

- `tags` must be a list of distinct names, none blank, with no comma and no leading or trailing whitespace, so that `--tag` can spell every one back (inner spaces are fine, quoted). Checked at registration, like `timeout`, `retries`, and `agent`; the `COLLECTION_ERROR` names the test file. A bare string such as `tags: 'smoke'` was read letter by letter, so `--tag smoke` never selected the test.
- `tests` in the config must be a glob or a list of globs, checked and compiled when the config resolves. A wrong type was a raw TypeError reported as a test failure with exit 1 (at config load for `tests: 5`, at collection for `tests: [1]`); it is `INVALID_CONFIG`, exit 2. A malformed glob was `INVALID_GLOB` only once a run or `e2e list` collected; it is now raised when the config loads, so `e2e explore`, `e2e mcp`, and `e2e cache` refuse a config no run could use.
