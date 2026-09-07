---
name: writing-pr
description: Use when writing or editing a pull request title or body.
---

# Writing a PR title and body

Reviewers skim. Put the shape of the change on the first screen, then let
diagrams and code carry the detail.

## Title

- Conventional Commits, matching `git log`:
  `fix(playwright): provision the browser in a runner-side prepare hook`.
  PRs squash-merge with the number appended, so the title is the commit.
- Mark spec or API breaks with `!` (`feat(config)!: ...`), same as the commit.
- Name the outcome, not the activity. "install builds with the appPath
  option", not "agent-device changes".

## Body

Do not write essays. A few bullets on what changed and why, then evidence.

- Bullet points for the prose you do write. One fact per bullet.
- A mermaid diagram for anything with flow or state: runner phases, engine
  hooks, replay paths, before/after architecture.
- Code samples: the new API, sample usage in a test file, or the key internal
  snippet. Fenced blocks with a language tag.
- Code refs (`packages/e2e/src/run/execute.ts:42`, GitHub permalinks) instead
  of paraphrasing code.
- Visual changes, direct or indirect (CLI output, reporter output, docs
  pages): a before/after table with uploaded images or videos.
- Benchmarks: a before/after table. Baseline is the target branch, candidate
  is the PR.
- Spec changes: name the chapter, schema, and `suiteVersion` bump in one
  bullet so the reviewer can check them together.

## Leave out

- "Validation" or "I ran tests" sections. CI reports that.
- Intermediate history. Squashed 6k lines down to 1k, refactored twice,
  renamed midway: none of it lands. Only the final aggregate squash-merge
  commit exists, so only that gets commentary.
- Line-by-line restating of the diff.
- Checklists nobody asked for, sign-offs, filler.

## Templates

Before/after for visuals:

```markdown
| Before | After |
| --- | --- |
| ![before](url) | ![after](url) |
```

Benchmarks:

```markdown
| Scenario | main | this PR | delta |
| --- | --- | --- | --- |
| testbed default suite | 41s | 23s | -44% |
```

Flow:

````markdown
```mermaid
flowchart LR
  A[collect] --> B[schedule]
  B --> C{cache hit?}
  C -- yes --> D[replay]
  C -- no --> E[act]
```
````

## Big changes

For truly impressive, difficult, high-risk, or wide-scoped changes, write the
body like a technical blog post: context, the problem, the approach, code
samples, diagrams, before/after, images. Storytelling is fine here. The rules
above still hold: no test logs, no intermediate history.

## Voice

Run the [unslop](../unslop/SKILL.md) pass on the final text before posting.
PR-specific tells to catch:

- "This PR introduces...", "comprehensive", "robust", "seamless", "ensures",
  "leverages", "enhances".
- Bold label lists that restate the line (`**Performance:** Performance...`).
- Em dashes. Use a comma, a colon, or a new sentence.
- Bullets padded to three because three felt right.
- A summary that could be pasted unchanged into another repo's PR.
