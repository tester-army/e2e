---
"@e2e-dev/web": patch
---

The web engine no longer observes Next.js App Router's route announcer, so its hydration-timed title echo cannot stop a replay. Older entries that recorded it re-record on the next read-write run.
