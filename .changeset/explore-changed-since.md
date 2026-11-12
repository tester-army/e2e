---
"e2e": patch
---

`e2e explore --changed-since <ref>` explores what a branch changed. The planner reads the commit messages and the committed diff since the merge base of the ref and HEAD, and plans its steps for the screens the change can affect. Only a defect the change can cause is an issue; one elsewhere is a warning. With no goal, the goal is the change. The report records the change as `run.explore.change`, and `explore()` on `e2e/runner` takes `changedSince` too.

```bash
npx e2e explore --changed-since origin/main
```
