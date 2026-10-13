---
"e2e": minor
---

Add `openHost<Fixtures>()` to `e2e/runner` for other test runners. A worker-lifetime host prepares the target, starts app processes, and initializes its engine once. `host.openSession({ name, timeout, signal, agent, onStep })` opens a fresh test-lifetime attempt with typed fixtures, its own deadline, steps, and artifacts. Only one hosted attempt can be opening, live, or closing per process; a host can open sessions sequentially.

A session's `timeout` is enforced: when it passes, every operation still running fails with `TEST_TIMEOUT`, the session is timed out, and `close()` reports it. A launch that fails or is cancelled leaves the host usable for the next session; only a session whose engine cleanup failed closes the host.

Closing a session writes a redacted `trace.md` under a safe, unique `results/host/` directory, available through the absolute `tracePath` for attachments. `close()` returns soft expectation and cleanup failures; async disposal throws an `AggregateError` when failures exist. Closing the host cancels any pending or active session, then disposes and releases its worker resources once. Both close methods are idempotent. `config` accepts a path or an `E2EConfig` value. The one-shot MCP attempt stays internal.
