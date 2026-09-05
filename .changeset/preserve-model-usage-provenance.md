---
"@e2edev/e2e": patch
---

Share model usage accounting between executor steps and judgment calls. Keep missing, partial, or estimated usage marked as adapter-upper-bound and reject invalid token counters and costs.

Sanitize judgment event counts before recording them. Cap unrepresentable token sums, mark their accounting non-authoritative, and omit overflowing cost totals.
