---
"@e2edev/e2e": minor
---

The package ships an agent skill: `SKILL.md` plus one reference file per
topic (`setup`, `writing-tests`, `agent`, `running`, `debugging`) that
teaches a coding agent to configure e2e, write tests, and read a failing run.
`e2e init` installs it into `.agents/skills/e2e/` and `.claude/skills/e2e/`
(a prompt on the first run, a silent refresh of the existing copies after an
upgrade), `e2e guide [topic]` prints it for an agent that lacks the files,
and `npx skills add tester-army/e2e` installs it from the repository.
