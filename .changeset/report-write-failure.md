---
'e2e': patch
---

A failed canonical-report write is an infrastructure run error
(`REPORT_WRITE_FAILED`), not a footnote: it joins the exit code (3) and the
run status, the returned in-memory report carries it, and `reportPath` — on
the outcome and the `run-finished` event — is present only when the file was
actually written. Previously a run whose report could not be written still
returned success and a path to a missing file.
