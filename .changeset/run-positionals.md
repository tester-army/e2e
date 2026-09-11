---
"@e2edev/e2e": patch
---

`e2e run` and `e2e list` match a positional that names no existing path by
name: `saved-tests.e2e.ts`, `regression/saved-tests.e2e.ts`, and `saved-tests`
all select `tests/regression/saved-tests.e2e.ts`. Before, such a positional had
to be the whole root-relative path or the run ended in `NO_TESTS`. The match is
exact and case-sensitive, ends at a path-segment boundary, and still never
selects a file the config globs did not discover.

A positional that starts with `-` and names no existing file is now a usage
error with exit code 2 instead of a file that matches nothing. `pnpm test:e2e
-- --headed` reaches the CLI as `run -- --headed`, so `--headed` used to be
swallowed and the run went on headless; the message now names the direct
command for the detected package manager with the whole forwarded tail
(`pnpm exec e2e run --tag smoke`). A file that really starts with a dash still
selects as before.
