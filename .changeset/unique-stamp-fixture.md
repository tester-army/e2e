---
'e2e': minor
---

A `stamp` test fixture and `unique` as a template tag. `stamp` is a string unique to the run and the test, the same for the whole attempt: `e2e`, the start millisecond in base36, four random characters, lowercase letters and digits only, so it survives slug fields, URL paths, and file names unchanged. `unique\`${stamp} Company\`` marks a derivation of it where it is written and returns the same `Unique` as `unique(string)`; pass it to every `act` that needs it instead of wrapping at each call. Templates interpolate strings, finite numbers, and earlier `Unique` values (`UniquePart`). `unique(value)` is unchanged. `stamp` is a core fixture name: `test.extend` and engine contributions may not redefine it.
