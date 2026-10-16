---
"e2e": patch
---

A TypeScript file that another loader (such as `tsx`) left with an inline source map that is not JSON or not shaped like a source map now loads, with stack traces pointing at that loader's output, instead of failing with a `TypeError`.
