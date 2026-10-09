---
"@e2e-dev/decision": patch
---

The completion check now sees where the step started and which actions changed the page. A navigation step reports its origin path next to the current page, and actions that changed the page are marked, so a link that moved from the start page to a new page reads as complete even when the label is generic such as Back. Steps that never left their page send no origin.
