---
"e2e": patch
---

`EnginePrepareInfo.headed` is now required, alongside the `headed` an engine already receives on `init`. A host that builds a `prepare` call now passes the run's mode, so an engine provisions for the browser that run launches.
