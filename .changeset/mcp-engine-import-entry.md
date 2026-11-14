---
"e2e": patch
---

`open_session` loads the entry of an engine package that `import()` would load, instead of its `require` entry, and reports an `exports` entry that `import()` refuses instead of loading the `require` one.
