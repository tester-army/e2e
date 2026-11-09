---
"e2e": patch
---

`e2e init` can write a CI pipeline for the web tests: a GitHub Actions workflow or a GitLab CI/CD job. The wizard asks for it in a project with the web engine and preselects the service the repository points to; `--ci github-actions` or `--ci gitlab` answers the question, and `--yes` alone writes none. The job uses the project's package manager and Node version, installs Chromium, runs `e2e run --reporter list,junit`, and keeps the report. For a project in a subfolder the file goes to the repository root. `init` names the secret or CI/CD variable to add and warns when nothing in the config starts the app. It never overwrites a pipeline file: beside an existing `.gitlab-ci.yml` it writes `.gitlab/e2e.gitlab-ci.yml` and prints the `include:` to add.
