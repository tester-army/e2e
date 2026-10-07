---
'@e2e-dev/mobile': patch
---

An iOS screen's location now names the screen by its navigation bar's title. A React Native native stack labels every pushed screen's bar with the back button's text, so screens read as the same one, and the location changed when agent-device switched accessibility backends; replay cache recordings on iOS handed off at their end check for this. A snapshot the iOS runner rejects mid-animation (a node outside its parent's clip, as an alert or modal dismisses) is taken again after the transition lands instead of failing the step with `APP_UNREACHABLE`.
