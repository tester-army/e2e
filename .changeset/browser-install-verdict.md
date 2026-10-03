---
"@e2e-dev/web": patch
---

A first run no longer re-downloads browsers it already has, and it no longer collects browser revisions a run did not install. The check asks for the build the run will launch: a headless run launches Chromium's headless shell and a headed run launches the full build. `PLAYWRIGHT_SKIP_BROWSER_GC=1` on the run's own environment still wins if you set it.
