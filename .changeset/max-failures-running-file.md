---
'e2e': patch
---

`--max-failures` no longer starts the next test in the file whose test reached the limit. The worker counts its own failures against the limit and skips the rest of its file with cause `failure-limit` at once, instead of starting the next test before the runner's interrupt arrives and reporting it `interrupted` as a second failure.
