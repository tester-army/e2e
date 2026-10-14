---
"e2e": minor
---

`e2e feedback` now asks for reports the e2e team can act on. A `--type bug` report needs `--repro`, steps that reproduce it every time. Without it, the command sends nothing and prints a prefilled GitHub issue instead, so the team can ask you for a reproduction there. When the registry confirms the installed e2e is older than the latest release, the report exits 2 and sends nothing, since the problem may already be fixed; upgrade and check again, or pass `--allow-outdated`. The new `--error-code` flag takes the e2e error code involved, and `--task`, `--expected`, `--actual`, and `--approach` now take at most 1500 characters.
