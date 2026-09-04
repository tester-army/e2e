---
'@e2edev/e2e': patch
---

A replayed step that navigates now waits for its recorded destination path
before the end state is judged. A step that moved to another pathname records
no anchors; the path is its whole postcondition, and the replayed tap that
starts the navigation returns before the new document commits. The replay read
the path once, right there, so every cross-page replay handed off as
`end-mismatch` and the executor paid for the step again. The path is polled
with the same settling backoff anchors use (100 to 3000 ms, 15 s cap, bounded
by the step budget), and a navigation step self-finalizes zero-turn like a
same-page one.
