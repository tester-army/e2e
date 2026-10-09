---
name: ship-pr
description: Take finished work in tester-army/e2e to a PR a human can review without fighting CI or bots - checks, verification against the built packages, a fresh-context self-review, the PR itself, then babysitting to the Ready for Human Review label. Use whenever you are asked to open, create, ship, or submit a PR, or when implementation is done and the next step is review.
metadata:
  internal: true
---

# Ship a PR

Opening a PR is not the finish line. The finish line is a PR labeled
`Ready for Human Review`: verified against the built packages, reviewed by a
fresh pair of eyes, green, and every bot thread handled. A human should only
ever spend time on judgment.

Run every step. If one cannot run, say which and why in the handoff instead
of skipping it quietly.

## 1. Checks

Run what CI runs for what you touched, and fix everything:

```bash
pnpm check                    # lint, dead code, typecheck, error codes, peer ranges, docs
pnpm test                     # or the touched package: pnpm --filter e2e run test:unit
pnpm --filter @e2e-dev/testbed test
pnpm test:web-benchmark       # when the runner, web engine, or benchmark changed
```

Then the repo rules `pnpm check` cannot see (`AGENTS.md`, "Contracts"):

- A user-visible change to a published package adds a `.changeset/` entry.
- Behavior changes update the matching `docs/**/*.mdx` page in the same
  change, "not implemented yet" callouts included, and `skills/e2e/` when it
  describes the changed surface.
- **Important:** every guide page the change touches (`docs/**/*.mdx`
  outside `docs/reference/`) gets the shortening pass in the
  [authoring-docs](../authoring-docs/SKILL.md) skill before you verify,
  even for a one-paragraph edit. Cut what the reader doesn't act on, merge
  what's said twice, and fold what only some readers need. Then check every
  new or merged sentence against `src/`. Put the before and after line
  counts in the PR body.
- A public API change reviews the emitted `.d.ts` and updates
  `packages/e2e/tests/types/sdk-types.ts`; a wire change edits the schema,
  both fixtures, and the producer together.
- A new build input or benchmark dependency goes into `.github/filters.yml`.

## 2. Verify

Prove the change with the [verify](../verify/SKILL.md) skill on the surface
it touches: the built CLI on the testbed or a benchmark, the MCP server, a
scratch project for `init`, or the docs site. Bug fixes capture main against
the branch. Keep the output and any video for the PR.

## 3. Self-review in a fresh context

The agent that wrote the change does not get to judge it. Spawn a reviewer
with no memory of this conversation (a subagent, or a new session) and give
it [references/review-prompt.md](references/review-prompt.md) with the base
branch filled in. Fix every `critical` and `important` finding you agree
with, then rerun steps 1 and 2 for what the fixes touched. For each finding
you reject, keep the one-line reason for the PR body or handoff.

No way to spawn a reviewer: re-read the whole diff cold against the same
prompt yourself, and say so in the handoff.

## 4. Commit and open

- Branch off an up-to-date `origin/main`. Commits follow Conventional
  Commits.
- Title and body with the [writing-pr](../writing-pr/SKILL.md) skill. The
  body carries the verification evidence from step 2.
- Open it ready, not draft:
  `gh pr create --base main --title ... --body-file <file> --attach <each screenshot and video>`
  (`gh` 2.99+). The body must carry the `## Verified` section `writing-pr`
  describes; fix a thin one with `gh pr edit --body-file <file> --attach ...`.
- Multi-PR change: open every layer, each based on the one below, before
  babysitting.

## 5. Babysit

Hand the PR to the [babysit](../babysit/SKILL.md) skill and run it to the
end: green, threads handled, `Ready for Human Review` label. For a stack,
babysit bottom-up; a layer is labeled only when it is ready on its own.

## Handoff

Reply to the human with:

- the PR URL and its label state
- how it was verified (surface, what you ran, what you saw, the media)
- what you fixed from review, what you dismissed and why
- anything left for them: escalated threads, parts you could not verify,
  scope you declined
