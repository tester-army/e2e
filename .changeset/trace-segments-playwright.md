---
'@e2edev/playwright': patch
---

`stopTrace` returns every trace archive the attempt wrote, in order, when a restart or a state reset cut the trace (`trace/trace-part<n>.zip` before `trace/trace.zip`), so the runner registers and redacts each segment instead of only the final one.
