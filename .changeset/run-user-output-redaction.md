---
'e2e': patch
---

`e2e run` redacts secret values from what the config's top-level code, a test file's top level, and reporters print, as it already did for tests, including what a timer or a reporter the run stopped waiting for prints after the run. Output printed while the config loads appears once it has loaded, and is withheld if the load fails. With the `list` reporter, output printed during the run prints under `stdout | runner` or `stderr | runner`, on stdout like a test's output, so the live view no longer paints over it.
