---
'e2e': patch
---

The terminal reporters measure text in terminal columns per grapheme cluster instead of UTF-16 code units. The live window's clamp no longer leaves a lone surrogate (a garbage glyph before the ellipsis) or splits an emoji sequence; CJK glyphs and emoji sequences (`❤️`, a ZWJ family, a keycap, a flag) count the two columns they paint, so the block's erase matches what was painted and no stale fragments remain after a repaint. Step labels, reasoning excerpts, the exploration header and step summaries, and the failure glance line are clipped by column too, so a CJK label no longer pushes the duration off the row. A piped log changes only where it holds wide glyphs: the step label's 72-column budget, the failure glance and the exploration step summary against the 80 columns a pipe reports, and the wrapped finding details count columns now, so a CJK label keeps half the glyphs it did; ASCII output is byte-identical.
