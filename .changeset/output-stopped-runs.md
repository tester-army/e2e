---
'e2e': patch
---

A run that stops before its tests start (`NO_TESTS` from a mistyped `--grep`, a collection error, `UNSUPPORTED_ARTIFACT`, `NO_LAST_RUN`, an app or service that fails to start, an interrupt) no longer clears `<output>/artifacts` or overwrites `<output>/report.json` and `<output>/ai-trace.json` (`output` defaults to `.e2e`): the previous run's evidence stays, and `--last-failed` still reads the last run that executed. The artifact tree is cleared once the app is up and tests are about to start.
