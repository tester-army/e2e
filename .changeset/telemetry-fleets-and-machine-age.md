---
'e2e': minor
---

Telemetry tells a fleet from its users: a platform that runs e2e on someone's behalf sets `E2E_TELEMETRY_FLEET=<name>` and its fresh machines are attributed to `fleet:<name>`, like CI, instead of each counting as a new user. Every event also carries the sandbox the kernel announces (`firecracker`), the JavaScript runtime and its version (`node`, `bun`, `deno`), whether the command created the preferences file, and the days since it was created (unknown for a preferences file from before this release). Every event also tells PostHog to skip its GeoIP step, so no location is derived from the request address, and the one-time notice shows again once because what is collected has changed.
