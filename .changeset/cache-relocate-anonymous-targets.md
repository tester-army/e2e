---
'e2e': patch
---

A control with no accessible name, text, placeholder, or test id, an unlabelled input in a form, is now recorded with its place among the unnamed controls of its kind and relocates by it on replay. It is matched strictly, so an unnamed textbox never stands in for a named one, and a change in the number of unnamed twins diverges as before. Such targets used to be unrelocatable outright, so every replay through an unlabelled form stopped at its first field.
