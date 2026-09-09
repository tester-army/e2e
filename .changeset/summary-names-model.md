---
"@e2edev/e2e": patch
---

The list reporter's `AI` summary row names the configured models after the
call count, `provider/id` plus `vision provider/id` when `agent.visionModel`
is set, so a long run's final summary carries them without scrolling back to
the header. The `run-started` event gains an optional `visionModel` field, and
the header names it too.
