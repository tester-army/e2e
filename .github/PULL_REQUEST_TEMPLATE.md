<!--
Title: Conventional Commits, `!` for a breaking change. It becomes the squash commit.
Body: a few bullets on what and why, then evidence (code, diagram, before/after).
See .claude/skills/writing-pr/SKILL.md. No test logs, no history.
-->

## What and why

-

## Checklist

- [ ] Changeset added (`pnpm changeset`) for any change to a published package, or the change is testbed, docs, or CI only.
- [ ] Breaking change: title carries `!`, the changeset body names what breaks and what replaces it, and the deprecation warning landed a window earlier (stability policy in CONTRIBUTING.md).
- [ ] Docs updated in the same PR: the `fern/docs/pages/*.mdx` page for the behavior, and `skills/e2e/` if the skill describes it.
- [ ] Contract change: emitted `.d.ts` reviewed, `tests/types/sdk-types.ts` updated; wire change edits the schema and both fixtures.
- [ ] Engine contract change (`@e2edev/e2e/engine`): changesets for `@e2edev/e2e`, `@e2edev/playwright`, and `@e2edev/agent-device`.
