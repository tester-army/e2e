---
"e2e": patch
---

`e2e upgrade` updates the project's copies of the agent skill in `.agents/skills/e2e` and `.claude/skills/e2e` to the newly installed version, instead of telling you to run `e2e init`. It also updates a stale copy when the packages are already up to date, and `--dry-run` names the copies it would update.
