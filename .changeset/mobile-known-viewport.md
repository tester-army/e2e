---
"@e2e-dev/mobile": patch
---

Keep the known viewport when a snapshot reads the app smaller than the screen. On iOS, a swipe from a sheet's grabber can pull down Notification Center, and the app's tree behind it reported a third of the screen (130x281 on a 390x844 device), which misplaced every rect and tap after it. A new size now replaces the known one only when it is a rotation or the simulator's screen agrees; a real device's screenshot reports no logical size to check against, so there the tree's size still stands.
