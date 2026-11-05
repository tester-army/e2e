---
"@e2e-dev/decision": patch
---

On a page with 255 or more elements, the decision executor no longer asks the model a target question with 256 choices, one over the TypeSafe limit of 255. Each question now lists at most 254 targets plus `none`. Elements past the cap are left out as before, and the model can scroll to reach them.
