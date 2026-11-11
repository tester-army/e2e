---
"@e2e-dev/browser-run": patch
"@e2e-dev/web": patch
---

Add a Cloudflare Browser Run browser provider and CDP handshake headers for hosted browser leases.

Retry rate-limited calls within a bounded, cancellable budget, journal session IDs so the parent can clean up after worker crashes.
