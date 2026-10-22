---
'@e2e-dev/mobile': patch
---

`device.dismissKeyboard()` on an iPhone no longer presses the control under the middle of the screen. The drag that sends a keyboard with no dismiss key away started at the exact centre and could toggle a checkbox or press a filter button there; it now starts at the nearest point no control covers, inside a scroll view when the screen has one, and a screen with no such point above the keyboard fails with `UNSUPPORTED_CAPABILITY` instead of touching it.
