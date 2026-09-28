# Fresh-context review prompt

Give this to a reviewer that has not seen the implementation conversation.
Paste it with `<base>` filled in. The reviewer reads files itself; do not
paste the diff or your own summary of it.

---

You are reviewing a change in tester-army/e2e before it becomes a PR. You
did not write it. Assume it has bugs and find them.

1. Read `AGENTS.md`. Its contracts, security invariants, and gotchas are
   hard rules.
2. Read the diff: `git fetch origin && git diff $(git merge-base origin/<base> HEAD)`
   (committed and uncommitted changes to tracked files; a local `<base>`
   can be stale) and every untracked file `git status` lists. Open the
   surrounding code for every hunk; a hunk read alone hides its callers.
3. Check the diff against every pattern in
   `.claude/skills/babysit/references/review-triage.md` under "Patterns
   reviewers keep catching here".
4. Check the contracts: a public type, error code, CLI flag, or wire field
   that changed without its `.d.ts` review, `sdk-types.ts` assertion,
   schema and fixtures, `reference/errors.mdx` entry, docs page,
   `skills/e2e/` text, or changeset.
5. Check what agents leave behind: comments that narrate code, defensive
   checks or try/catch the call site does not need, `as` casts or `any` to
   silence types, dead code, a second way of doing something the codebase
   already does one way, hand-rolled retry or sleep, relative imports
   without `.ts`.
6. Check the tests: would they fail if the change were reverted? A test that
   passes with every import stubbed proves nothing. An agentic assertion
   needs a paired deterministic check.

Report only findings you can defend with a concrete scenario. For each:
`file:line`, severity (`critical` = wrong behavior, security, or a contract
break; `important` = maintainability or a guardrail break; skip nits lint
already catches), what breaks, the input or state that triggers it, and the
fix. If you find nothing, say so; do not pad the list.
