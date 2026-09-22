---
'e2e': patch
---

`e2e init` no longer writes the agent skill through a symlink. A `.claude/skills/e2e` or `.agents/skills/e2e` that is a link (to a dotfiles repo, a shared skills folder, anywhere) had its target's `SKILL.md` replaced and `references/` written there, silently under `--yes`. The link, or a linked parent, is now left alone: `--yes` prints `Symlink, not touching: <link> -> <target>`, and an interactive run asks before replacing the link with a copy, defaulting to no.
