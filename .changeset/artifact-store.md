---
'@e2edev/e2e': minor
---

`ArtifactStore`: the cloud seam for evidence, the way `TraceCacheStore` is for
traces. `artifacts` accepts `{ kinds, store }`; a host-supplied store receives
every artifact the moment it is complete on disk — bytes, digest, and report
identity — not after the run, and returns its own reference, recorded on the
artifact as `ref` beside the local path. A failed `put` never fails the run;
the record simply carries no `ref`. Without a store nothing changes. The
report schema gains the optional `artifact.ref` (`suiteVersion` 0.8.0 → 0.9.0).
