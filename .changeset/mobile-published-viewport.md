---
"@e2e-dev/mobile": patch
---

The mobile engine measures an observation in the viewport agent-device publishes with each snapshot (0.21.21), and infers it from the tree's largest window or rect extent only for a snapshot that publishes none. On a snapshot that publishes one, a tree that doesn't reach the screen's edges no longer shrinks the viewport, so a system panel above the bottom of the screen is no longer taken for the navigation bar.
