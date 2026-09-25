---
'e2e': patch
---

The trace cache no longer records a step whose `unique()` value collides with another param. A recording is text with no note of which param a value came from, so `act('fill the title {title} and choose {frequency}', { params: { title: unique(title), frequency: 'Daily' } })` recorded while the title happened to be `Daily` stored the `select` of the plain choice as the title's slot, and the next run selected its new title as the frequency. Such a step now runs and passes as before but writes no entry, and `step.cache.notRecorded` in the report reads `param-collision`; the next run, with a value of its own, records it. The recorded verdict summary is also no longer rewritten: it stays as the model wrote it during the recording run, since a value spelled inside its prose came back as the current run's value in text the run never produced. Entries recorded earlier still replay; only their verdict text fills the slot they carry.
