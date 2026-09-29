---
'e2e': patch
---

`output` and `--output` are checked against the project root and `cache.dir` with symlinks resolved: `--output "$PWD/out"` in a checkout under a symlinked directory (`/tmp` on macOS) is accepted, and a `cache.dir` spelled through a symlink under `<output>/artifacts` is refused instead of deleted by every run. A symlink whose target does not exist yet is followed, so an `output` or `command.log` through one that points outside the project root is refused at load. An output that is a file, or under one, fails at load with `INVALID_CONFIG` instead of `REPORT_WRITE_FAILED` at the end of the run, and a refused default output is named `".e2e" (the default)`. The removed `--artifacts <dir>` suggests `--output .e2e` when its parent could not be an output.
