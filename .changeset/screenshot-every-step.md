---
'e2e': minor
---

A new `screenshot` option chooses the screenshots the runner takes on its own: `on-failure` (what it did before, and the default while the evidence pack is off), `every-step` for one after every top-level step that passes, attached to that step in the report, or `off` for none. It is set like `trace` and `video`: at the top of the config, on a target, with `--screenshot <mode>`, or on a test or describe. No screenshot is taken after a secret fill; a step under `every-step` records a `PIXEL_TAINTED` policy event instead.
