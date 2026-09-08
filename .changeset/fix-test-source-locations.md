---
'@e2edev/e2e': patch
---

Report `source` now locates the `test()` declaration instead of a runner
frame: collection skipped only `dist/` frames, but the shipped source maps
point them at `src/`, so every result claimed the registry's own call site.
`junit.xml` testcases also carry `file` and `line` attributes.
