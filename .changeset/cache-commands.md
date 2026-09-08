---
"@e2edev/e2e": minor
---

`e2e cache ls`, `e2e cache stats`, and `e2e cache clear` read and empty the
trace cache. Until now the only controls were `--no-cache` and deleting the
directory, and a reviewer of a committed cache had no way to see what it held:
entry files are named after the digest of their key. `ls` prints the test, the
target, the instruction digest, the age, and the action count of every entry,
`stats` prints the entry count and the size, and `clear` deletes the store's
files and the directory. Recorded traces now carry the test, target, and
instruction digest they were recorded for, which is where `ls` reads them
from; entries written by an earlier version replay as before and list with
`-` in those columns.
