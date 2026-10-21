---
"e2e": patch
"@e2e-dev/github": patch
---

Add test filters: `filters: [decisionFilter({ model })]` from `@e2e-dev/decision` leaves out the tests a change can't affect. They run with `--changed-since <ref>`, such as `origin/main` on a pull request; without the flag every test runs. `e2e list --changed-since origin/main` previews the decision, and left-out tests show in the pull request comment, `junit.xml`, and the report. A run with nothing to run starts no engine or app, and after Ctrl-C, or a reporter that runs past its deadline, the CLI exits as soon as the output is written.
