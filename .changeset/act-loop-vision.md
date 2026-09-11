---
"@e2edev/e2e": minor
---

The act loop sees pixels. Two tools join the built-in agent's grammar while no
secret has been filled in the attempt: `screenshot()` attaches a masked
screenshot of the viewport to its result, and `tap_at({ x, y })` taps a point
given in that screenshot's pixel coordinates. The act model receives the image
itself, so nothing is lost in a description and no second model call is spent
on a localizer. Once a screenshot was sent the step is in pixel mode: every
action result carries a fresh screenshot, and older screenshots are elided
from the conversation in batches, keeping the newest two, and each is
resampled to a long side of at most 768 pixels, so a long flow on a canvas
carries a bounded number of images at a third of the full capture's cost.
While the step shows pixels, the wait after an action watches the pixels too,
so a tap that redraws a canvas is read as soon as the redraw lands. A screen that lists nothing to act
on by id opens with a screenshot already attached. `tap_at` is routed onto the
tree: a listed control under the point is tapped by id through the ordinary
`tap` path, policy and trace descriptor included; a point on nothing listed is
tapped as a bare point through the engine's new `tapAt` member and recorded as
a trace gap. The executor socket gains `actions.tapAt(point)` with the same
routing and `pixelsTainted`; the engine contract gains an optional
`tapAt(point, context)` with the `pointer` capability and the `tapAt` grammar
verb, and pins `SemanticNode.rect` to the top-level viewport's CSS pixels for
nodes inside nested documents too. `agent.visionModel` is gone: the act model reads
screenshots itself, so it is multimodal by requirement, and the judgments
send their pixels to the same `model`.
Steps that sent pixels record `visionInput` and `metrics.pixelBytes`.
