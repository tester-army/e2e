---
'e2e': patch
---

An `act` step in pixel mode, where every tool result after a `screenshot` call carries its text beside an image, gets the same loop discipline as a text-only step. The failure-streak guard read only text results, so three or five failed actions in a row after a screenshot never asked the model to change approach or forced a verdict; it now reads the text beside the image. Superseded full screens that arrived with a screenshot were never elided, so a long pixel flow grew every turn until the provider refused the request and the step ended `CONTEXT_OVERFLOW` with "nothing left to shrink" instead of retrying; they now elide like text screens, the retry clips the newest one, and the image, or the notice that replaced it, stays in place.
