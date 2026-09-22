---
'e2e': patch
---

Two tests whose ids share their first 120 characters (a monorepo path, a describe, a long title) wrote their artifacts into one directory, so one test's `failure.png` and screenshots replaced the other's and the report's `path` and `sha256` named the wrong evidence. A test id past the cap now ends its directory name in a digest of the whole id, so each test gets its own; ids within the cap keep the names they had. A result's source file resolves against the project root as a directory, so a sibling directory sharing the root's prefix (`/repo/app-shared` beside `/repo/app`) is no longer reported as `-shared/...`; the report names the test file instead.
