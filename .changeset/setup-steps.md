---
"@e2edev/e2e": patch
---

The run narrates its setup and keeps it off the wrong clock. Everything
before the first test is now a `setup` step on the event stream: `collect`,
each target's engine `prepare`, and every service and app command, `started`
then `finished` with its length (and `reused` when an already running process
was attached). The runner validates the process declarations first, then
collects, then provisions each engine, emits `plan`, and only then starts the
services and app, so `NO_TESTS` is reported before any dev server boots and a
missing browser is fetched before the app starts.

The list reporter shows the step in flight with a ticking clock
(`❯ preparing playwright engine for target "web" 12.30s`,
`❯ starting service "postgres" 4.10s`), prints each finished process once
(`✓ service "postgres" ready 41.20s`) and a provisioning step when it narrated
(`✓ playwright engine for target "web" prepared 13.20s`), and an interrupt
that lands during setup names the step it cut short (`interrupted while
starting service "postgres": tearing down`). `Start at` and `Duration`, and
the report's `run.startedAt`,
count from `plan`: a first-run browser download is not on the clock, while
service and app startup is, split out as `(startup 41.20s)`. A run whose only
test took 3s no longer reports 17s because Chromium was fetched first.
