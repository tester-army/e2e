---
"@e2e-dev/mobile": minor
---

`device.fold(pose)` puts a foldable iOS simulator (iPhone Duo) in a hinge pose: `'closed'` lights the outer display, `'half-open'` (a 130° book) and `'open'` the inner one. It runs agent-device's `fold` command, which sends the simulator's hinge event and reads the angle back from CoreDevice before it resolves, so the next observation reads the app on the other display. Like `setOrientation`, it counts as an action for the `transition` budget. A device without a hinge is `UNSUPPORTED_CAPABILITY`, and Android is refused before any device command. The pose type is exported as `FoldPose`.
