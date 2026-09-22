---
'@e2edev/web': patch
---

`web.evaluate(fn)` runs a function that declares a named helper inside its body. The runner loads test files through tsx, whose esbuild `keepNames` output wraps `const pick = () => ...` in a module-scoped `__name` helper; the serialized source carried that call into the page, where it failed with `EVALUATE_FAILED: __name is not defined`. Only string sources and flat arrows worked. The page-side wrapper now declares the same helper beside the inlined source.
