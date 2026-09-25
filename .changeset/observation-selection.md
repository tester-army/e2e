---
'e2e': minor
'@e2edev/web': minor
---

An observed node carries `selection`, the text selected inside the focused field or editing host, and the screen the agent reads renders it as `selection="..."` beside the value. A `press` of `Shift+ArrowLeft` now shows what it selected, and `press` takes `times` (1 to 20, each press one recorded action, as a scroll repeat is), so the agent extends a selection to exactly one word in one more call, where before it pressed blind, one key per turn, and bolded the wrong span. A secure field reports no selection, as it reports no value. The web engine reads it from an input's or textarea's selection range and from the document selection inside a `contenteditable` host; a collapsed caret reports none.
