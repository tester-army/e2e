---
'@e2edev/playwright': patch
---

Observation and lifecycle hardening in the browser backend:

- One deadline bounds a whole observation: settling, the main document, every
  same-origin iframe, and the pixels each spend from what remains, so nested
  frames can no longer stretch one `observe` past the operation budget.
- An observation cancelled by the harness no longer publishes its handle
  generation over the one the caller still holds refs into.
- `locate` no longer derives a CSS selector for every matched element on every
  assertion poll; nothing consumed it. The tree walk memoizes role, name, and
  direct text per element and reuses the computed style it already holds, and
  each document is read with one fewer protocol round trip.
- A function dialog handler that returns without calling `accept` or `dismiss`
  now has the dialog dismissed and fails the next step with `INVALID_STATE`
  instead of leaving the page blocked behind it.
- A first-run browser download and the browser launch honour the init signal.
- A trace segment that cannot be written during `clearState` or session
  restore is best-effort and can no longer leave the surface on the old context.
