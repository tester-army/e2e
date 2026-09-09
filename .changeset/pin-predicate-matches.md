---
"@e2edev/playwright": patch
---

A node an exact label query or a display-value query found is pinned to its
element. Such a match is one candidate among many (every labelable control,
every input with a value), and its ref used to re-resolve by position when the
action ran, so a page that inserted or removed an element in between made the
action land on a neighbor: a `fill` on a "Project Name" field hit a button
and failed as "not an input". The element handles are taken beside the read
that matched, and a count that differs between the two re-reads.
