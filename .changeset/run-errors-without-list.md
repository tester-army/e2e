---
"e2e": patch
---

`e2e run` without the `list` reporter prints each run error on stderr as `CODE: message`. Before, `--reporter junit` or `markdown` with a test file that failed to collect, a config that failed to load, or no model for the agent exited 2 and printed nothing.
