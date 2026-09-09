---
"@e2edev/playwright": minor
"@e2edev/agent-device": patch
---

`SelectOption` on the engine contract gains a `{ value }` variant. Playwright
selects by the option's `value` attribute; the device engine's `selectOption`
stays `UNSUPPORTED_CAPABILITY` for every variant.
