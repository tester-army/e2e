---
"e2e": patch
---

Agent `navigate` to a full URL on the app now records it without the origin, so cached steps replay when the app runs on another port or host with the same `app.identity`. Re-record older entries to pick this up.
