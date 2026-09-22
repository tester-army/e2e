---
'e2e': patch
---

`pressSequentially` no longer sends one more character after its timeout cuts a pause. The pause capped by the deadline ends the typing by itself, instead of a clock read after the sleep that a timer firing a hair early could pass.
