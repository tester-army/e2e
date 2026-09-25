---
'e2e': patch
---

A point tap or hover recorded on a screen the tree lists poorly replays instead of handing off as `target-ambiguous` or `target-not-found`. When several nested look-alikes of the recorded container hold the point, a React Native host view and the view inside it under one label, the recorded point on a viewport of the recorded size names the same pixel whichever of them was recorded, and it is tapped as a bare point would be. Look-alikes that merely overlap under the point without nesting still hand off, since which one is on top may have changed. A container with nothing to re-find it by, a group among groups on a screen merged into one accessibility node, is no longer recorded at all: the point stands alone, and an entry that still carries one replays the point. A container that is gone still hands off.
