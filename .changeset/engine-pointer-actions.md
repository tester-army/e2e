---
'e2e': minor
---

Breaking: the engine contract's pointer side is a vocabulary, not one verb, and the vocabulary is finished before the contract locks.

- `Engine.tapAt(point)` is `Engine.performAt(point, action)` with a required `pointerActions` list, mirroring `perform` and `actions`. `PointerAction` is the pointer subset of the action kinds: `tap`, `doubleTap`, `secondaryTap`, `longPress`, `hover`, `dragTo` (to a second point), and `swipe` (from the point). The harness routes a point action only for a declared kind; the agent's `tap_at` verb needs the `tap` kind in `actions` or `pointerActions`. `POINTER_ACTION_KINDS`, `PointerAction`, and `PointerActionKind` are exported from `e2e/engine`.
- `secondaryTap` joins the action kinds and `Locator.secondaryTap()` performs it: a right click, a two-finger tap.
- `SemanticNode.states` gains `pressed` and `SemanticNode` gains `level`; `getByRole` takes `pressed` and `level`, so a toggle button and a heading level are queries on every engine.
- `EngineSnapshot.viewport` is `{ width, height }`: the `scale` it carried meant nothing (every engine reported 1 and nothing read it); `ObservationPixels.scale` remains the image-to-CSS ratio.
- `Platform`, `ScrollDirection`, `Momentum`, and `SelectOption` are defined by the contract (`e2e/engine`) and re-exported by `e2e`, so the SPI owns its own vocabulary.

`spiVersion` stays `1`.
