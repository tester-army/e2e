---
'@e2edev/github': patch
---

Source links in the pull request comment resolve for a project below the checkout root. The report's files are relative to the project root, so a suite in `packages/e2e-tests` linked to `blob/<sha>/tests/...` and 404ed; the link now carries the project's path inside `GITHUB_WORKSPACE`.

Evidence links open the run page's Artifacts section (`actions/runs/<id>#artifacts`) and the page names each file's path inside the upload, so a reader finds the screenshot or trace in the downloaded artifact instead of landing on the run page.
