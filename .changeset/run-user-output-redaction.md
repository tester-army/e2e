---
'e2e': patch
---

`e2e run` redacts secret values from what the config's top-level code, a test file's top level, and reporters print, as it already did for tests. Output printed while the config loads appears once it has loaded, and is withheld if the load fails. In a terminal, that output prints above the live view under `stdout | runner` instead of being painted over.
