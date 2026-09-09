---
"@e2edev/playwright": patch
---

A node an exact label query or a display-value query found is pinned to its
element. Such a match is one candidate among many (every labelable control,
every input with a value), and its ref used to re-resolve by position when the
action ran, so a page that inserted or removed an element in between made the
action land on a neighbor: a `fill` on a "Project Name" field hit a button
and failed as "not an input". The handles are taken first and the semantics
are read from those very handles, so what was read and what is acted on are
one set of elements. Handles that did not match are released at once, and a
located element ref is released when the registry prunes or clears it, so a
long attempt no longer accumulates browser objects.
