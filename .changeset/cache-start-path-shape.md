---
'e2e': patch
---

A recording replays on the page it began on up to the ids the app mints per record. A step that edits or deletes a record a previous step created starts on `/companies/<id>`, and that id is new on every run; the start check compared it literally and missed with `wrong-context` every time. It now uses the same shape comparison as the end-of-step check.
