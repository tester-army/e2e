---
'@e2edev/e2e': minor
'@e2edev/playwright': minor
---

Backends get a `prepare` hook: once per run and target, in the runner process,
before any worker starts and outside every launch budget. The Playwright
backend installs a missing browser there instead of inside `init`, so a
first-run download is no longer charged against `launchTimeout`, no longer runs
once per worker, and its progress streams as new `notice` run events. The list
reporter prints those above its live status block, where before the block's
repaint erased the download output written to a worker's stderr and a first run
looked hung on a spinner.
