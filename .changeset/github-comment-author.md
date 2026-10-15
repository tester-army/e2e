---
'@e2e-dev/github': patch
---

The reporter now updates a pull request comment only when its token's user wrote it. With `GITHUB_TOKEN` or a GitHub App token, which can't look up their user, any bot account's comment matches.
