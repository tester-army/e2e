---
"@e2e-dev/mobile": patch
---

An iOS screen's location takes its title from the navigation bar's identifier instead of its label, which is the back button on a pushed screen, and ignores a Swift class name an untitled SwiftUI screen leaves there; iOS recordings that start on a pushed screen re-record once (`--strict-cache` runs fail with `REPLAY_STALE` until then).
