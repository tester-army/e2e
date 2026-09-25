---
'e2e': patch
---

`e2e init` writes the agent skill once. With `.agents/skills` and `.claude/skills` both chosen, the `--yes` default, the copy goes to `.agents/skills/e2e` and `.claude/skills/e2e` is a relative symlink to it (`../../.agents/skills/e2e`), the layout `npx skills add` produces, so one copy serves every agent. A project with two copies from an earlier version gets the link on its next `init` when the Claude Code copy holds nothing but the shipped files; one with other files in it stays a copy and is refreshed. A `.claude/skills/e2e` that already leads to the copy, itself or through a linked `.claude/skills`, needs nothing. A link elsewhere keeps its rules: skipped with a warning under `--yes`, and offered a replacement when asked, now the link rather than a second copy.
