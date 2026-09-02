---
'e2e': minor
---

`defineTool` replay annotations gain two tiers (RFC0003 phase 1). Beside
`deterministic` and `none`, a tool may declare `{ mode: 'located', locate:
[...] }` — input paths that are node references, relocated against a fresh
observation on replay — or `{ mode: 'fixed-model' }` — one recorded model call
at replay, allowed only on a non-mutating tool. The bare `'deterministic'` /
`'none'` strings stay accepted as sugar and normalize to the object form on the
defined tool. This phase validates and records the declaration; the located and
fixed-model replay wiring lands in later RFC0003 phases, so a tool declared with
either tier runs live until then, exactly as `none` does.
