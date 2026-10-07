---
"e2e": minor
---

The MCP server's `tap`, `double_tap`, and `right_click` tools take an optional `modifiers` list (`Shift`, `Control`, `Alt`, `Meta`, `ControlOrMeta`) on an engine that declares `tapModifiers`, holding the keys for the click — the same `{ modifiers }` the test API's `tap` takes. A Shift-click extends a selection, a Control-click (Meta on macOS) toggles one item. The keys travel through the action grammar to the engine, are recorded with the action, and replay with it.
