---
"e2e": minor
---

`e2e mcp` sessions are now headless by default, the same as `e2e run` and `e2e explore`. Pass `--headed` to show the browser or simulator. Before, sessions were headed outside CI and `--headless` hid them; `--headless` is still accepted, since it now asks for the default, but it is no longer documented.
