---
"e2e": patch
---

`e2e explore --changed-since <ref>` explores what a branch changed. The planner reads a brief of the change since the merge base of the ref and HEAD: the commit messages, each changed file, and committed patches up to a size budget. It plans its steps for the screens the change can affect, and is told to report only a defect the change can cause as an issue and one elsewhere as a warning, a call it can get wrong. A file no commit changed, and a committed file's later local edits, are named, never read. Secret values the config gives as strings are redacted before the brief is cut to fit. With no goal, the goal is the change. The report records the change as `run.explore.change`, and the markdown and GitHub comment name it under the goal. `explore()` on `e2e/runner` takes `changedSince` too.

```bash
npx e2e explore --changed-since origin/main
```
