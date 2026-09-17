---
'@e2edev/agent-device': patch
---

Pins `agent-device` to 0.21.6 (from 0.21.1). The Simulator accessibility bridge now reports `enabled` from the NotEnabled trait, so `toBeDisabled` passes on iOS Simulator again; scroll and record recovery fixes from 0.21.2 through 0.21.6 come along.
