---
"@e2e-dev/decision": patch
---

The decision executor now forwards an element's `selected` state to the model, the same way it already forwards `checked` and `expanded`. Without it, a tab bar's active tab looked identical to the rest, so the completion check for a tab switch landed near 50/50 and sometimes blocked a step that actually worked, or claimed a step done before anything was tapped.
