---
"@e2e-dev/browser-run": patch
"@e2e-dev/web": patch
---

Add a Cloudflare Browser Run browser provider and CDP handshake headers for hosted browser leases.

Retry rate-limited calls within a bounded, cancellable budget, offer read-only live-view links for the actual test tab, and journal session IDs so the parent can clean up after worker crashes. Add an optional provider page notification for live-view integrations.
