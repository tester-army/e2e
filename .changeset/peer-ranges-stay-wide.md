---
'@e2edev/web': patch
'@e2edev/mobile': patch
'@e2edev/github': patch
---

The peer range on `e2e` is `>=0.15.0 <1` again instead of the exact version of one runner build, so updating `e2e` alone no longer leaves an unmet peer that npm refuses with ERESOLVE, and a runner release no longer republishes the engines and the reporter.
