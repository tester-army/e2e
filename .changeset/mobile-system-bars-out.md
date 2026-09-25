---
'@e2edev/mobile': patch
---

Android's status bar and navigation bar stay out of the tree. agent-device reports them as windows of `com.android.systemui` beside the app's, and their clock, signal, and battery read differently from one run to the next, so a step recorded with "T-Mobile, three bars" among its end anchors handed every replay off to the model once the emulator read "signal full". The notification shade, quick settings, and system dialogs stay: they cover the screen rather than hug an edge. So does a heads-up notification or another compact systemui popup: a bar spans the screen edge to edge, a popup sits inset from the sides.
