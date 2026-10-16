---
"@e2e-dev/mobile": patch
---

An iOS screen's location takes its title from the navigation bar's identifier only when the bar shows that text, not from the bar's label or a class name left in the identifier, and an Android toolbar's resource id is no longer a title; iOS recordings that start or end on a pushed screen, and Android recordings whose path ends in a toolbar resource id, re-record once (`--strict-cache` runs fail with `REPLAY_STALE` until then).
