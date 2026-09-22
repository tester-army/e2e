---
'e2e': patch
---

Screen text from the app under test can no longer notify anyone or plant a link from the markdown page and the `@e2edev/github` comment: a token GitHub would link on its own (`@someone`, `@org/team`, `#123`, `https://...`, `www....`, an email address) in a test title, an expected or observed value, the agent's explanation, a turn outcome, or an explore finding is shown as code, the one rendering GitHub's autolink filters skip, since entities and backslashes before `@` and `#` are undone before those filters run. A quoted line or the explore assessment that starts with `#`, `-`, `+`, `1.`, or `---` is escaped so it stays prose instead of becoming a heading, a list, or a rule. Target and agent names may no longer be only dots: `.` and `..` passed the name rule and became artifact path components, so a target named `..` wrote beside `report.json` with artifact paths the report-1 schema rejects; the sanitizer maps an all-dot segment to `_` as well.
