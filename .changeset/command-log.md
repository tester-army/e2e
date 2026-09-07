---
"@e2edev/e2e": patch
---

A backend's `command`, every `services` entry, and every service `teardown` accept a `log` path. When set, the runner appends the process's stdout and stderr to that file (resolved from the project root, kept inside it through symlinks, parent directories created) instead of discarding them, so a dev server that dies on boot or a migration that fails can be read back without wrapping the command in a shell redirect. Output is still discarded when `log` is unset. The file is unredacted, so `e2e init` now also adds `.e2e/logs/` to `.gitignore`.
