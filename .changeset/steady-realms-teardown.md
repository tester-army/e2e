---
'e2e': patch
---

Runner lifecycle fixes and speedups:

- `afterAll` now runs for a realm a failing or timed-out test discards, and
  before a serial group takes over a file; previously suite teardown was
  skipped on every failure and retry.
- Serial groups and setup tests now run `beforeAll`/`afterAll` for their
  scopes like ordinary tests. A `beforeAll` failure inside a serial group
  skips its members as `hook-failed` and fails the group without retrying.
- A test whose retry hits a `beforeAll` failure keeps its recorded attempts
  and reports `failed`, not `skipped`.
- A worker that cannot re-import a unit's module no longer drops that unit's
  tests from the report; they are recorded as infrastructure failures.
- Ctrl-C during app start or collection now stops the app process group and
  removes the session directory; the readiness probe is bounded and backs off
  instead of polling every 250 ms.
- Each worker imports a unit's test file once instead of twice; session states
  are decrypted once per worker; artifact hashing runs off the event loop.
