---
"e2e": patch
"@e2e-dev/web": patch
---

`scrollUntilVisible` no longer pauses 100 ms between swipes. On web, a swipe resolves once the scroll it caused is on screen, so the next read sees the scrolled page.
