---
'@e2e-dev/kernel': patch
---

A Kernel error no longer carries a trailing newline into the run's error: a bad `KERNEL_API_KEY` reads `browser provider "kernel" could not lease a browser: 401 Invalid or disabled API key while preparing engine web for target "kernel"` on one line.
