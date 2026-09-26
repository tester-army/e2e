---
'e2e': patch
---

Two tests in one run whose ids differ only in characters the artifact directory name cannot hold (`artifact a` and `artifact_20a`: the space percent-encodes to `%20`, and both `%20` and `_20` became `_20`) shared one artifact directory, so the second test's failure screenshot and screen text wrote over the first's and the first report entry's `sha256` no longer matched the file on disk. A directory name the safe alphabet rewrote now ends in an 8-hex digest of the whole id, as a name past the length cap already did, so every test keeps evidence of its own. A test id holds a `/` and a `::`, so every test's artifact directory and its `.e2e/failures/` page name move once to the digested name; the paths in `report.json` match what is on disk.
