---
"e2e": patch
---

A worker that crashes during a retry no longer drops the attempts before it. Before, a test whose first attempt failed and whose retry crashed the worker showed a single attempt 0 with `WORKER_CRASH`, and the first attempt's error was lost. The report now keeps every finished attempt and adds the crash as the next one. A crash after the last attempt (in an `afterAll`) is recorded on that attempt instead of as a retry. For a serial group, the finished group attempts and the members that finished in the crashed attempt stay in the report, the member that was running fails with `WORKER_CRASH`, and a crash after a member finished fails the group attempt without blaming that member. A forced interrupt keeps the attempts that finished and the verdict they reach, `flaky` included.
