---
"e2e": minor
"@e2edev/playwright": minor
"@e2edev/agent-device": patch
---

Recover semantic-capture timeouts with fresh, independently masked screenshots.
The engine contract distinguishes unavailable semantics from a valid empty
tree. The runner respects vision settings and secret taint, retires stale
references, and disables trace reuse for affected steps. Playwright supports
the fallback; device captures still fail closed when accessibility data
cannot establish screenshot masks.

Playwright bounds the complete semantic capture and reserves node IDs before
the reader starts. An abandoned capture cannot reuse IDs or publish late
references. Pixel-only evidence resets the agent's semantic screen comparison
and stops cache probes without discarding the recovered screenshot.

Reports accept judgment steps that fail before a model call without inventing
an observation revision or verdict explanation.
