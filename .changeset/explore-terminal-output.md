---
'@e2edev/e2e': minor
---

`e2e explore` reads as an exploration, not as a test. The terminal shows each step by its title as it finishes, with its duration, actions, and findings, and each finding the moment the agent reports it. The run ends with a `Findings` section, issues first and the most severe first, each with where it was seen, what was expected against what the screen showed, the steps that reach it, and its screenshot; then the assessment and `Findings` and `Steps` summary rows. Severity reads as a word (`critical` to `trivial`). The exploration's progress travels as a new `explore` run event, so custom reporters see it too; the summary rows the explore reporter used to add are gone. The planner titles steps as short headings and closes with a verdict, what was not reached, and what is worth scripting.
