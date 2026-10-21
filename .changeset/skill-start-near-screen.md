---
"e2e": patch
---

The bundled agent skill now tells a coding agent to start each test near the screen it checks, so every rerun skips the steps that lead there: a saved session instead of the sign-in form, `app.open` on the screen's path, and data created through the app's API in a `test.extend` fixture. A test across several screens grows one screen at a time, with the goals already verified replaying from the cache. Core concepts says the same in one bullet.
