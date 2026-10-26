---
"e2e": patch
---

`e2e run` and `e2e explore` refuse an empty `--reporter` (`--reporter ''`, `--reporter ','`, or `--reporter "$REPORTERS"` with the variable unset) as a usage error, exit 2, instead of running with no reporters and printing nothing.
