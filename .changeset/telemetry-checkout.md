---
'e2e': patch
---

The CLI sends no telemetry when it runs from a source checkout of the repository: the package's `src` beside its `dist` turns it off, `e2e telemetry` reports `running from a source checkout of e2e`, and no notice prints. Work on e2e itself no longer counts as usage; an installed or unpacked package, which ships no `src`, is unaffected.
