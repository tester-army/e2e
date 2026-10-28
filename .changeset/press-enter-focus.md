---
'@e2e-dev/mobile': patch
---

`press('Enter')` on a field taps it first when it is not focused, as a character key already did. Before, Enter went to whatever held focus, and on iOS failed when the keyboard was down.
