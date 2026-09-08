---
'@e2edev/e2e': minor
---

`e2e init` writes an `## e2e` section into the project's `AGENTS.md`,
creating the file when missing and appending otherwise. The section is the
short form of the skill: where tests live, how to run one file, how to read
`.e2e/report.json` or `--reporter json`, and what `.e2e/cache/` is. It sits
between `<!-- e2e:start -->` and `<!-- e2e:end -->` markers, so a later
`init` refreshes only that text and leaves the rest of the file alone. After
writing, `init` prints where to copy the section for `CLAUDE.md` and Cursor
rules.
