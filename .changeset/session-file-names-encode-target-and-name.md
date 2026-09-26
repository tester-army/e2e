---
'e2e': patch
---

A session file's name tells the target and the session name apart. Before, the store wrote `<target>--<name>.json`, so target `a--b` with session `c` and target `a` with session `b--c` shared one file, the second save overwrote the first, and with two workers the consumer of the overwritten one failed with `SESSION_MISMATCH` (exit 2) after both setup tests passed. The name now ends in a 16-hex digest of the pair, which is what keeps two pairs apart, behind a readable prefix of each part escaped outside ASCII letters, numbers, and `_` and cut to 40 characters, so no part can hold a path separator or a `..` segment and a 128-character session name with any target name stays well under the 255-byte file name limit. Sessions live for one run and are deleted at cleanup, so nothing needs migrating.
