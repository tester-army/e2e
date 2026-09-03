---
'@e2edev/playwright': minor
---

Observation node ids are stable per element: the reader stamps an id on each
element the first time it is observed and reads it back afterwards, so an
element keeps its id across observations for as long as it lives in the
document. Closed `<select>` controls list their options (up to 60) as child
nodes, and `selectOption` by label accepts the one option whose label matches
case-insensitively, by prefix, or by containment when no exact label exists.

Observations wait for the data requests earlier actions set off (`xhr`,
`fetch`, `document`; collected during the action and a 120 ms effect window;
bounded by 5 s) before reading the tree, so a save whose result arrives from
the server is observed with its result rather than with the screen the click
left behind.

Table rows and cells are observed as `row`, `cell`, and `columnheader` nodes
instead of being flattened into their text and buttons, so a control inside a
row can be told apart from the same control in the next row.
