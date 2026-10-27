# Repairing a case

Two modes, each with a fixed set of fields it may write: Mode A rewrites
Execution, Mode B only adds to Guardrails and Intent. Use the mode the
classification named; do not mix them in one change.

## Mode A: the path is stale (`outdated-test-logic`)

Execution no longer leads to the Intent, but the spec still asks for it.
You may rewrite `Execution` only.

1. Read Intent and Guardrails. The new path must reach the same Intent
   without breaking a guardrail.
2. Fetch the refs: the summary's `resolveRefs` command when it has one,
   else `npx e2e-cige refs <id>` (add `--variant <v>` for a variant). Read
   the spec and the release notes for what changed.
3. Look at the live app before you write a step: start `e2e mcp` (the e2e
   skill's `mcp` topic) in the case's environment, open `Context.open`, and
   walk the flow. Don't guess at a UI from the old steps.
4. Edit the steps. Keep the ids of the steps that still mean the same
   thing; give a new step a new id. A step is one goal, not a click
   sequence. A `use` step is Execution too: you may change its `with` or
   its kind (one a plugin registers), but never a plugin's code in
   `cige.config.ts`.
5. Replay: `npx e2e-cige replay <id>`, once per variant with
   `--variant <v>` when the case has variants.
   Repeat until it passes. If no path reaches the Intent within the
   guardrails, stop: it is probably a `product-defect`. Read
   `escalate.md`.

## Mode B: a false positive

The case passed, but the pass didn't prove the Intent. You may only make
the case stricter:

- add a guardrail, or a `deny` pattern to an existing one, that blocks the
  shortcut the agent took;
- add a `success` or `failure` criterion the screen must meet;
- add an `Intent.evidence` item. Prefer an `assert` item, or a hook the
  config already declares. A new hook edits `cige.config.ts`, so `diff`
  blocks it with `config-changed`: hand it over as a proposal for a human.

Then replay twice: on the build that gave the false pass the case must now
fail, and on a correct build it must pass. Without a correct build at hand,
say so in the hand-off.

## Prove it kept the Intent

```bash
npx e2e-cige diff --base origin/main --json
```

Mode A should show only `execution-changed`, with `intentUnchanged: true`.
Mode B shows only additions (`guardrail-added`, `deny-added`,
`criteria-added`, `evidence-added`) and `blocking: 0`. Its
`intentUnchanged` is `false` when it added criteria or evidence; that is
expected, since the Intent got stricter, and `blocking: 0` is what counts. Any blocking change
means the repair went past its mode: undo that part, or hand it to a human
as a proposal. That includes `context-changed` and `config-changed`.

`diff` sees the case files, the CIGE config, every file the config loads
(aliases, workspace packages, and lazy imports included), and the
package.json that maps them. A config it can't load, or whose imports use
computed names, blocks as `config-unverified`. An app helper a hook imports
is in that graph, so changing it needs a human too. It can't see other app
code or installed packages: a repair that touches them is out of scope, so
leave them alone.

## Hand off

The diff of the `.cige.json`, the replay's result, and the `diff --json`
output, in the pull request or wherever a human reviews it. Never merge a
repair yourself.
