---
"@e2edev/e2e": minor
---

The `'fallback'` vision mode is gone. It was documented as behaving like
`false` for every judgment, because a judgment always answers from the tree and
has no miss to escalate on, so it never did anything. `VisionMode` is now
`boolean | 'only'`; a config or call that still passes `'fallback'` fails with
`INVALID_CONFIG` or `INVALID_ARGUMENT` naming the accepted values. Replace it
with `false` (the tree) or, where pixels were wanted, `true` or `'only'`.
