---
"e2e": patch
"@e2e-dev/github": patch
---

Add test filters: `filters: [decisionFilter({ model })]` from `@e2e-dev/decision` leaves out the tests a pull request can't affect. They run only on a GitHub pull request, a GitLab merge request, or with `--changed-since <ref>`; tests whose test file, stored screenshots, or setup file changed always run, a known lockfile, such as `pnpm-lock.yaml`, `Podfile.lock`, or `Cargo.lock`, or a config change runs every test, `pull_request_target` runs every test, a `--last-failed` rerun is never filtered, and `--no-filter` turns them off. `e2e list --changed-since origin/main` previews the decision, and left-out tests show in the pull request comment, `junit.xml`, and the report. A run with nothing to run starts no engine or app, and Ctrl-C exits as soon as the output is written.
