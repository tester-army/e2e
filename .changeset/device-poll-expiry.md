---
"e2e": patch
---

Stop device-code login at the code's expiry even when a token request stalls, and avoid polling a code that expired during the wait interval.
