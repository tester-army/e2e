---
"e2e": patch
---

The bundled e2e skill now writes tests with one top-level `describe` per feature, one behavior per test, and arrange, act, assert order with every assertion at the end, instead of a check after each `agent.act`.
