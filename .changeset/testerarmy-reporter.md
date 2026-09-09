---
"@e2edev/testerarmy": minor
---

The TesterArmy reporter. `reporters: ['list', testerarmy()]` uploads every
finished run to TesterArmy — the report-1 document and the screenshots,
traces, and videos it names, sent once per content digest — and prints the
run's URL under the summary. It reads the key from `TESTERARMY_API_KEY` (or
the variable `apiKey` names) when the run finishes; without one it uploads
nothing and says so in one summary row. `project` picks the project;
`TESTERARMY_BASE_URL` picks the host. CI attribution (commit, branch, pull
request, job link) is read from GitHub Actions, GitLab CI, CircleCI,
Buildkite, or Vercel and sent beside the report.
