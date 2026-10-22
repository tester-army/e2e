# Classifying a CIGE result

Run this after every CIGE run, pass or fail, before anything is repaired.
Its only output is a classification and the one reference allowed to act.

## Read the summary

Open `.e2e/cige/<id>.run-summary.json` (`<id>.<variant>...` for a
variant). It points at everything else; read those only when a step below
needs them.

| Field | Use |
| --- | --- |
| `failedStep` | The Execution id, evidence id, or `intent` that failed |
| `failureType` | The reporter's first guess from the error code. Absent when the code can't decide |
| `classification.signals` | What it read: `guardrail-violation:<id>`, `automation-limit`, `screen-only-evidence`, `missing-spec-ref` |
| `specRef`, `buildRef`, `expectedRef` | Pointers to the ground truth |
| `resolveRefs` | The command that fetches them into `.e2e/cige/<id>.refs/`; present only when the config has resolvers |
| `evidence.trace` | The trace page: every step, action, and judgment |
| `replay.command` | How to rerun this result once a repair is in |

## Decide, in this order

1. **Did the case reach the system?** A failed precondition, `phase:
   precondition`, or an auth, environment, or seed-data code, or
   `MODEL_UNAVAILABLE` or `MODEL_PROVIDER_FAILED`, means no. Classify
   `infrastructure` and read `recover.md`. (`MODEL_REFUSED` is an
   automation limit: step 5.)
2. **Did the path stop working?** An Execution `step` that failed with
   `LOCATOR_NOT_FOUND`, `LOCATOR_AMBIGUOUS`, `ACTION_FAILED`, or
   `REPLAY_STALE`. First read the error and the trace: an `ACTION_FAILED`
   that timed out or hit an unresponsive or unloaded page is the
   environment, so go back to step 1. Otherwise a control that is gone
   (`LOCATOR_NOT_FOUND`) or that is there but fails or is ambiguous
   (`ACTION_FAILED`, `LOCATOR_AMBIGUOUS`) is either a changed flow or a
   defect, so get the ground truth: run the
   summary's `resolveRefs` command when it has one; otherwise read the
   summary's `specRef` and `buildRef` pointers directly. Stop if either is
   unavailable. Then compare the spec with the release notes for this
   build:
   - The release notes change this flow or control, and the spec still asks
     for the Intent: `outdated-test-logic`. Read `repair.md`.
   - The spec still asks for the control or step, and the release notes
     don't change it: the app lost or broke it. `product-defect`. Read
     `escalate.md`.
   - The spec dropped the Intent: a changed requirement. Read
     `escalate.md`, which decides whether to propose an Intent change.
   - Neither ref settles it: stop, as below.
3. **Did the app do the wrong thing?** A `verify`, evidence item, or the
   Intent judged false (`ASSERTION_FAILED`) on a healthy environment with a
   current path. Classify `product-defect` and read `escalate.md`.
4. **Did a guardrail fire?** `guardrail-violation:<id>`. The agent took a
   forbidden path: either the flow changed and now routes through it
   (repair Execution so it avoids it), or the product forces it (a
   defect). The spec decides; never loosen the guardrail.
5. **No `failureType`, signal `automation-limit`.** A spent budget or the
   clock. Open the trace: a path that wandered is `outdated-test-logic`; a
   slow page is `infrastructure`; a model that gave up on a clear screen
   needs a stronger model in the e2e config, not a case change.
6. **A pass.** Check it for a false positive when it carries
   `screen-only-evidence` and the Intent claims an effect the screen can't
   prove, or when the trace shows the agent reached the end state by a
   shortcut the Intent did not mean. A confirmed one goes to `repair.md`,
   mode B.

A run whose terminal summary shows a `CIGE gaps` row has cases without
the refs or environment this needs. Run `npx e2e-cige check` and name the
gaps in your hand-off, so the user fixes them before the next triage.

A summary whose `classification.adjustedBy` names plugins was changed by
the project's own rules: read those plugins in `cige.config.ts` before you
overrule them, and treat their signals as evidence. `plugin-error:<name>`
means a plugin failed, not the case. A failing `use` step (a plugin's
step kind, `CIGE step <id> (<kind>) failed`) is the project's code checking
the system: its message says what it saw.

When two answers fit and the refs can't separate them, stop. Write what
you saw and what would decide it, and hand it to a human. Do not guess and
repair.

## Record it

Write one line per case in your hand-off: the id (and variant), the
classification, the evidence for it (the code, the trace step, the ref you
read), and the reference you are routing to.

| Classification | Read | May change |
| --- | --- | --- |
| `infrastructure` | `recover.md` | The environment. Context only with approval |
| `outdated-test-logic` | `repair.md`, mode A | Execution |
| false positive | `repair.md`, mode B | Add guardrails, deny patterns, criteria, or evidence |
| `product-defect` | `escalate.md` | Nothing. Files a defect, or proposes an Intent change |
