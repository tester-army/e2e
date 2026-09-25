---
'e2e': patch
---

A session file's name encodes the target and the session name apart. Before, the store wrote `<target>--<name>.json`, so target `a--b` with session `c` and target `a` with session `b--c` shared one file, the second save overwrote the first, and with two workers the consumer of the overwritten one failed with `SESSION_MISMATCH` (exit 2) after both setup tests passed. Each part now escapes every character outside ASCII letters, numbers, and `_` as `%XX`, so the `--` between them is unambiguous and no part can hold a path separator or a `..` segment; a name of plain letters and numbers reads as before. Sessions live for one run and are deleted at cleanup, so nothing needs migrating.
