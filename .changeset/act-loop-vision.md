---
"@e2edev/e2e": minor
---

The act loop gets a pixel tier. Two tools join the built-in agent's grammar
while no secret has been filled in the attempt: `tap_visual({ description })`
taps a visible target the tree does not list (a shape or pin painted on a
canvas, a region of an image, a control inside a system sheet), and
`look({ question? })` describes the screen from its pixels as text. Both are
answered by the agent's `visionModel` (its `model` when none is pinned) and
counted as model calls of the step; the agent model itself never receives an
image, so any act model works and the transcript stays text. For `tap_visual`
the harness captures masked pixels, asks the vision model for one point (or an
abstain with a reason, relayed with what to do instead), scales the point into
the observation's coordinates, and hit-tests it against the tree: a listed
control under it is tapped by id through the ordinary `tap` path, policy and
trace descriptor included; a point on nothing listed is tapped as a bare point
through the engine's new `tapAt` member and recorded as a trace gap. The
executor socket gains `actions.tapAt`, `vision.tap`, `vision.look`, and
`vision.tainted`; the engine contract gains an optional `tapAt(point, context)`
with the `pointer` capability and the `tapAt` grammar verb, and pins
`SemanticNode.rect` to the top-level viewport's CSS pixels for nodes inside
nested documents too. Steps that sent pixels record `visionInput` and
`metrics.pixelBytes`, and the report gains an optional step `visionModel`
record so the vision model's calls and tokens are never booked under the act
model.
