---
"e2e": patch
---

`open_session` loads the `import` entry of an engine package that exports separate `import` and `require` entries, as `import()` would, instead of the `require` one.
