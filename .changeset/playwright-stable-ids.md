---
'@e2edev/playwright': minor
---

Observation node ids are stable per element: the reader stamps an id on each
element the first time it is observed and reads it back afterwards, so an
element keeps its id across observations for as long as it lives in the
document, and an executor can diff two observations instead of re-reading
the screen. Closed `<select>` controls list their options (up to 60) as child
nodes. Table rows and cells are observed as `row`, `cell`, and
`columnheader` nodes instead of being flattened into their text and buttons,
so a control inside a row can be told apart from the same control in the
next row.
