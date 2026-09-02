---
'e2e': patch
---

Agent step fixes and prompt savings:

- The wind-down window that forces `complete_step` scales with the step
  budget (a quarter of it, capped at 60 s) instead of a flat 60 s that took
  half of a default 120 s step.
- A project tool (`defineTool`) that throws an ordinary error now returns the
  failure to the model as text, like a grammar action, instead of failing the
  step as `MODEL_PROVIDER_FAILED`. A mutating project tool is refused before it
  runs once the action budget is spent, and a failed call consumes its slot.
- An executor that brings its own model no longer triggers resolution of the
  configured `agent.model`, so a missing credential for an unused model cannot
  fail the run.
- The initial screen tree in the step prompt is compacted like later
  snapshots once newer observations exist; step params are serialized
  compactly. `agent.waitFor` no longer takes five throwaway observations per
  judgment interval.
- Late model or tool accounting from an executor abandoned by a hard stop can
  no longer land on the following step. Step transcripts pass the secret
  redactor before they are written.
