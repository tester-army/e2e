---
"@e2edev/e2e": minor
---

A target's `name` is optional and defaults to its `platform`:
`targets: [{ platform: 'ios', engine }]` is the target `ios`. Names stay
unique, so two targets on one platform still name themselves; leaving both
unnamed is `INVALID_CONFIG` with a hint saying so. Errors raised before a
target's name is known (an unknown key, a missing platform) point at the entry
as `targets[<index>]`.
