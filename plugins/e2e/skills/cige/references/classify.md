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
| `failureType` | The reporter's first guess from the failing phase and step, plus the error's class and code. Absent when they can't decide |
| `classification.signals` | What it read: `guardrail-violation:<id>`, `automation-limit`, `screen-only-evidence`, `missing-spec-ref` |
| `specRef`, `buildRef`, `expectedRef` | Pointers to the ground truth |
| `resolveRefs` | The command that fetches them into `.e2e/cige/<id>.refs/`; present only when the config has resolvers |
| `evidence.trace` | The trace page: every step, action, and judgment |
| `replay.command` | How to rerun this result once a repair is in |

## Decide, in this order

1. **Did the case reach the system?** A failed precondition (`phase:
   precondition`), or an error of class `infrastructure` or
   `configuration` in `report.json` (sign-in, environment, seed data, the
   model provider), means no. The reporter sets `failureType:
   infrastructure` for these. Read `recover.md`. Two `configuration` codes
   are not the environment: `REPLAY_STALE` is a stale path (step 2), and
   `POLICY_DENIED` is step 4, or, when it names no guardrail, a step the
   runner refused (read the message). A blocked test step, such as
   `MODEL_REFUSED`, is an automation limit: step 5.
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
   current path. Classify `product-defect` and read `escalate.md`. An act
   step that ended `ASSERTION_FAILED` with `goal-unreachable` is not this:
   the agent couldn't reach its goal. Run step 2's ref comparison on it as
   if it were a path code: the refs decide between a changed flow and a
   defect, and when they don't, stop.
4. **Did a guardrail fire?** `guardrail-violation:<id>` (the runner stopped
   a forbidden action), or `guardrail-refused:<id>` or a bare
   `guardrail-refused` when it named none (the agent read a guardrail and
   refused before acting). Either way the step needs a
   forbidden action: the flow changed and now routes through it (repair
   Execution so it avoids it), or the product forces it (a defect). The
   spec decides; never loosen the guardrail.
5. **No `failureType`, signal `automation-limit`.** A blocked test step
   (not `APP_NOT_OPEN`, usually a missing `Context.open`), a spent budget,
   or the clock. Open the trace: a path that wandered is `outdated-test-logic`; a
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
overrule them, and treat their signals as evidence.

A `plugin-error:<name>` signal means a plugin's `classify` failed, not the
case; the classification is the reporter's own.

A failed `use` step runs a plugin's step kind. When the plugin threw an e2e
error, the summary keeps its code and message: classify by them as usual.
A plain throw shows as `CIGE step <id> (<kind>) failed: ...` with the signal
`plugin-step-failed:<id>` and no failure type: read the message and the
plugin's code, since a step kind may set up data or call an API as well as
check.

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
