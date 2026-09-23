---
'@e2edev/mobile': patch
---

An iOS text field that shows its placeholder reads as empty. XCTest reports the placeholder as the value of an empty field, so `toHaveValue('')` after `clear()` observed the hint text on a host without the simulator's accessibility bridge; the node's hint flag now empties the value.
