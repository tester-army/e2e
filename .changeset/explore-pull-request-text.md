---
'e2e': patch
---

`e2e explore --changed-since` reads the pull request's title and description on a GitHub Actions `pull_request` run or a GitLab merge request pipeline, so testing steps written there guide the plan. A claim that the change needs no testing doesn't decide a skip.
