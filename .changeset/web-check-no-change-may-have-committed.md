---
'@e2e-dev/web': patch
---

Actions whose input reached the app now fail as `ACTION_MAY_HAVE_COMMITTED` instead of `NOT_ACTIONABLE`: a `check` or `uncheck` whose click left the control unchanged, and a `press` that timed out waiting for the navigation its key started.
