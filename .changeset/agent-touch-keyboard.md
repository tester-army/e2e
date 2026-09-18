---
'e2e': minor
---

The built-in agent reads a phone keyboard the way the platform does. An action result says when the on-screen keyboard closed with the action, because on a touch screen the tap that closes it is often spent on closing it and the control under the finger did not react; the model is told to act on it again rather than read an unchanged screen as success. The execution rules now require the latest result to show the asked-for outcome before a passed verdict: a result reporting no change, or only the keyboard closing, means the decisive action did not land. `scroll` repeats up to 20 screens in one call instead of 5, so a long list costs turns in proportion to its length rather than five screens at a time.
