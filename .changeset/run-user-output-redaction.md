---
'e2e': patch
---

`e2e run` redacts secret values from what the config's top-level code, a test file's top level, and reporters print, as it already did for tests. Output printed while the config loads appears once it has loaded, and is withheld if the load fails. That output now prints through the list reporter under `stdout | runner` or `stderr | runner`, on stdout like a test's output, so the live view no longer paints over it.
