---
"e2e": patch
---

A replay no longer fails its end check on a value that changes every run, such as a clock or a date, when the other side of the step's delta already holds a stable result like a deleted row.
