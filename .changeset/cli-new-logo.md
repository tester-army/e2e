---
"e2e": patch
---

`e2e init` and `e2e --help` show the new e2e logo, its six rows of bars drawn in half blocks. In `e2e init` the logo appears glitched, its rows shifted sideways, and the rows settle into place top to bottom in half a second. The logo needs a terminal at least 52 columns wide, and prints without motion on one shorter than 10 rows.
