---
"@e2e-dev/insights": patch
---

Add `@e2e-dev/insights`: the `insights()` reporter keeps a history of runs,
the `e2e-insights` command reports flaky and broken tests, replay cache
misses, model cost, and the slowest tests as text, Markdown, HTML, or JSON,
and `quarantineFilter()` leaves flaky tests out of pull request runs.
