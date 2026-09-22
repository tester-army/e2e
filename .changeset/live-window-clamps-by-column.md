---
'e2e': patch
---

The terminal live window clamps its lines by terminal column instead of UTF-16 code unit. A title cut inside an emoji no longer leaves a lone surrogate, which showed as a garbage glyph before the ellipsis, and CJK or emoji titles are clamped and counted at the two columns each glyph paints, so the block's erase matches what was painted and no stale fragments remain after a repaint. Piped output is unchanged.
