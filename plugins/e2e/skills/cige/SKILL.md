---
name: cige
description: Writes, classifies, and repairs CIGE test cases (Context, Intent, Guardrails, Execution) run by @e2e-dev/cige on e2e. Reads a run summary, decides whether a failure is the environment, a stale path, a product defect, or a false pass, then makes the one repair that kind allows, replays the case in its environment, and proves the change kept the Intent with e2e-cige diff. Use when a project has .cige.json files or a cige.config.ts, when asked to write an agentic test case, after a CIGE run, or when a CIGE test fails and someone asks to fix, heal, or triage it.
---

# CIGE: agentic test cases that repair safely

A CIGE case is a `.cige.json` file with four fields, and each field has a
different owner:

| Field | Says | Who may change it |
| --- | --- | --- |
| Context | Where the case runs, and the refs to its spec, build, and expected output | A repair for environment drift, with a human's approval |
| Intent | Why the case exists and what a pass needs | A human. A repair may only add criteria or evidence |
| Guardrails | What the agent must never do | A repair may only add rules or deny patterns |
| Execution | The first path to try | A repair for a changed flow |

`@e2e-dev/cige` runs each case as an e2e test and writes one run summary
per result to `.e2e/cige/<id>.run-summary.json`. The `e2e-cige` command
replays a case in its environment, resolves its refs, and checks a change
against the table above. Every step below goes through them; none needs a
tool outside the project.

## Start here: pick the reference for the job

| When you are | Read |
| --- | --- |
| Writing or reviewing a case: fields, dimensions and variants, evidence hooks, refs, environments | [references/authoring.md](references/authoring.md) |
| A CIGE run just finished, pass or fail, and nothing has been repaired yet | [references/classify.md](references/classify.md) |
| The classification is `infrastructure` | [references/recover.md](references/recover.md) |
| The classification is `outdated-test-logic`, or a pass was a false positive | [references/repair.md](references/repair.md) |
| The classification is `product-defect` | [references/escalate.md](references/escalate.md) |

Always classify first. A repair you were not routed to is how a bug gets
hidden: a failing check rewritten until it passes.

## Rules

- Ask for ground truth before writing cases, not after a failure: where
  the spec is, where release notes and expected output come from, and how
  each environment resets. `references/authoring.md` lists the questions.
  `npx e2e-cige check` shows what is still missing.
- Never edit Intent's statement, remove a success or failure criterion,
  remove evidence, set `"judge": false`, remove a guardrail or a deny
  pattern, remove a variant, or change a case's `id` on your own. Propose
  it, and stop for a human.
- Never treat a pass as proof when its summary carries
  `screen-only-evidence` and the Intent claims something the screen cannot
  show (a record saved, an email sent, a charge made). Check it as a
  possible false positive.
- Never put a secret in a case, a ref resolver's output, or a summary you
  write. Secrets come from e2e's `secrets` config.
- Replay every repair alone before you hand it over:
  `npx e2e-cige replay <id>`, once per variant with `--variant <v>` when
  the case has variants. It resets the environment and runs the case with
  the replay cache off.
- End every repair with `npx e2e-cige diff --base origin/main --json` and
  put its result in the hand-off: `intentUnchanged`, `blocking`, and each
  change. A blocking change needs a human, whoever made it. Never pass
  `--allow-intent`: it is the human's override, and it records nothing.

## Commands

```bash
npx e2e run --tag cige                      # every CIGE case
npx e2e run --tag cige:<id>                 # one case, every variant
npx e2e-cige replay <id> [--variant <v>]    # reset its environment, run it alone, no cache
npx e2e-cige env reset <environment>        # provision | reset | teardown, no case touched
npx e2e-cige refs <id>                      # spec, release notes, expected output into .e2e/cige/<id>.refs/
npx e2e-cige check [--resolve]              # what each case lacks to be classified and replayed
npx e2e-cige diff --base origin/main        # what changed, and which changes need a human
```

The e2e skill (`npx e2e guide <topic>`) covers the runner itself: config,
targets, agents, `e2e mcp` to look at the live app, and error codes. The
CIGE page of the docs ships in `node_modules/e2e/docs/cige.mdx`.
