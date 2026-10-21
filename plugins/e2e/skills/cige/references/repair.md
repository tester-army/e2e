# Repairing a case

Two modes, each with one field it may write. Use the mode the
classification named; do not mix them in one change.

## Mode A: the path is stale (`outdated-test-logic`)

Execution no longer leads to the Intent, but the spec still asks for it.
You may rewrite `Execution` only.

1. Read Intent and Guardrails. The new path must reach the same Intent
   without breaking a guardrail.
2. Run the summary's `resolveRefs` command and read the spec and the
   release notes for what changed.
3. Look at the live app before you write a step: start `e2e mcp` (the e2e
   skill's `mcp` topic) in the case's environment, open `Context.open`, and
   walk the flow. Don't guess at a UI from the old steps.
4. Edit the steps. Keep the ids of the steps that still mean the same
   thing; give a new step a new id. A step is one goal, not a click
   sequence.
5. Replay: `npx e2e-cige replay <id>` (add `--variant <v>` for a variant).
   Repeat until it passes. If no path reaches the Intent within the
   guardrails, stop: it is probably a `product-defect`. Read
   `escalate.md`.

## Mode B: a false positive

The case passed, but the pass didn't prove the Intent. You may only make
the case stricter:

- add a guardrail, or a `deny` pattern to an existing one, that blocks the
  shortcut the agent took;
- add a `success` or `failure` criterion the screen must meet;
- add an `Intent.evidence` item, usually a hook that checks the backend
  (add the hook to `cige.config.ts`; it holds only when it returns `true`).

Then replay twice: on the build that gave the false pass the case must now
fail, and on a correct build it must pass. Without a correct build at hand,
say so in the hand-off.

## Prove it kept the Intent

```bash
npx e2e-cige diff --base origin/main --json
```

Mode A should show only `execution-changed`, with `intentUnchanged: true`.
Mode B shows only additions (`guardrail-added`, `deny-added`,
`criteria-added`, `evidence-added`) and `blocking: 0`. Any blocking change
means the repair went past its mode: undo that part, or hand it to a human
as a proposal.

## Hand off

The diff of the `.cige.json`, the replay's result, and the `diff --json`
output, in the pull request or wherever a human reviews it. Never merge a
repair yourself.
