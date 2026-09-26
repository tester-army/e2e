---
'@e2edev/web': patch
---

A file input reads as `button`, the role Chrome and Playwright give it, instead of `textbox`. `getByRole('button', { name })` finds it, and the agent no longer treats it as a field it could type into or fill with a secret. A committed trace-cache recording that uploads through `textbox "<name>"` stops replaying and hands the step to the agent; re-record it.
