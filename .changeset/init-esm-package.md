---
"@e2edev/e2e": patch
---

`e2e init` now sets up the package, not only the files: it creates a private ESM `package.json` when none exists, adds the runner and the chosen packages to `devDependencies` while preserving existing versions and module type, and offers to install them with the project's package manager. The wizard picks a backend (none, Playwright, or agent-device, defaulting to iOS on macOS and Android elsewhere) and whether to enable AI testing; `--yes` enables AI with no backend and no installation.

Loading a `.ts` config or test outside an ESM package now fails with an actionable message instead of a loader error.
