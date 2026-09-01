# 11 - Collection, Lifecycle, Sessions

This document defines the runner state machine for `runner-0.1`. Terms and
algorithms in this document are normative.

## Terms

- A **collection realm** imports test modules only to register declarations.
- An **execution realm** is an isolated JavaScript module/worker realm used to
  run one file against one target. Realms are never shared across targets.
- A **suite instance** is one file or nested group in one execution realm.
- A **test attempt** is one execution of a non-serial test against one target.
- A **serial-group attempt** executes every member of one serial group, in
  declaration order, against one shared driver session.
- A **scope** is run, target, worker, suite, test, or attempt. Every acquired
  resource has exactly one owning scope and one finalizer.

## Collection

Collection uses registration during module evaluation. Module exports have no
role in discovery.

**Normative algorithm:**

1. Resolve config and test globs as described in 05-config.md.
2. Normalize matched paths relative to the project root with `/` separators,
   sort them by Unicode code point, and import each module once in a collection
   realm.
3. Calls to `test()`, `test.setup()`, hooks, and `test.describe()` register
   synchronously in declaration order. A `describe` callback MUST finish
   synchronously. Registration attempted from a timer, promise continuation,
   or after module evaluation is a collection error.
4. `test()` return values and module exports are ignored by collection. A
   runner MUST NOT collect an exported `TestCase` a second time.
5. Each title must be 1 through 512 UTF-8 bytes after Unicode NFC and must not
   contain NUL. Encode its UTF-8 bytes with RFC 3986 percent encoding: ASCII
   letters, digits, `-`, `.`, `_`, and `~` remain literal; every other byte is
   uppercase `%HH`. Join the
   complete title path with `::`. A test ID is
   `<normalized-relative-file>::<encoded-title-path>`. Literal `%` and `:` are
   encoded, making the form unambiguous. Duplicate normalized title paths in
   one file are collection errors.
6. A setup ID is `setup::<test-id>`.

Top-level await in a test module is a collection error in `sdk-0.1`. Test files
MUST NOT perform app, driver, model, credential, or dynamic-resource work while
being imported.

## Option resolution

Options resolve in this order, highest precedence first:

1. CLI override, for options exposed by the CLI.
2. Test declaration.
3. Nearest containing group, then each outer group.
4. Config.
5. Specification default.

`tags` union and de-duplicate. `agentContext` concatenates outer-to-inner with
newlines. `platforms`, `requires`, `session`, `timeout`, and `retries` replace
inherited values. `retries` means additional attempts and MUST be an integer
from 0 through 10. Timeouts MUST be positive safe integers.

Inside a serial group, test-level `retries` is a collection error. The group
uses its resolved retry count for the whole group.

Setup tests MUST be top-level. They cannot appear in `describe`, inherit group
options, consume a session, or belong to a serial unit.

## Selection

After collection, the runner expands each ordinary test and setup test into
test-target pairs.

1. File arguments, tags, and `only` select tests by intersection. Multiple
   `--tag` flags form a union unless `--tag-mode all` is used.
2. `platforms` removes nonmatching targets.
3. `requires` removes targets whose driver manifest lacks a required
   capability. This is reported as `skipped` with cause
   `capability-unavailable`, not as a runtime fixture failure.
4. A selected test with `session: name` automatically selects that session's
   setup producer for the same target, regardless of file or tag filters.
5. A pre-skipped or filtered test acquires no fixtures and runs no per-test
   hooks. Suite hooks run only when their suite has at least one runnable pair.

Selecting any member of a serial group selects the complete group atomically.
File, tag, and `only` filters cannot create a partial serial execution. The
report records members included only because of serial closure.

CI mode MUST reject `.only`. Zero runnable ordinary test-target pairs is a
configuration error unless `--pass-with-no-tests` is present. Setup tests do
not satisfy the nonzero requirement by themselves.

## Execution hierarchy

For each selected target, the runner executes required setup tests first. It
then schedules file-target execution realms across workers. A runner MAY reuse
a worker process, but a target failure, timeout, or unhandled exception MUST
discard that worker before another attempt begins.

Every retry imports the file in a fresh execution realm and reruns applicable
`beforeAll` hooks. An initial realm may execute multiple non-serial tests, but
module state is never carried from a failed realm into a retry.

Driver launch and session restore use the separate launch timeout and occur
before any test/member timeout starts. Launch/restore timeout or backend failure
is infrastructure error and is not test-retry eligible. It still creates the
framework attempt record: an ordinary attempt fails before hooks; a serial-group
attempt fails with every member skipped as `infrastructure-unavailable`. One
serial-group launch/restore budget applies to the group attempt.

Each independent test attempt receives:

- a logically fresh driver session;
- a fresh fixture graph and test-scoped resources;
- a fresh ledger;
- fresh route, dialog, download, artifact, and event-handler registrations;
- an attempt-specific artifact directory.

Pooling is allowed only when behavior is observationally equivalent to a fresh
instance, including storage, handlers, pending operations, and process state.
The framework does not isolate application-server or database state. Tests
that mutate shared backend state MUST provision unique data, use isolated
tenants, or opt into serial execution.

## Hooks

`beforeAll` and `afterAll` receive only `SuiteFixtures`. They cannot access
driver-backed fixtures. Shared authenticated UI state belongs in setup tests
and sessions, not suite hooks.

For one runnable test, hook order is:

1. outer `beforeAll` when entering a suite instance for the first time;
2. inner `beforeAll` when entering each nested suite instance;
3. outer-to-inner `beforeEach`;
4. test body;
5. inner-to-outer `afterEach`;
6. inner-to-outer `afterAll` after the last runnable member leaves each scope.

Hook declarations execute in declaration order within the same phase and
scope. Teardown hooks execute in reverse declaration order.

If `beforeAll` fails, remaining tests in that scope are skipped with the hook
failure as cause. `afterAll` still runs for every scope whose `beforeAll`
started. If `beforeEach` fails, the body does not run; `afterEach` still runs
for every entered scope. Teardown and cleanup errors are retained as secondary
errors and never replace the primary failure.

A suite-hook failure is also a top-level run error with its source scope.
`beforeAll` is primary and causes `hook-failed` skips. `afterAll` is secondary
to an existing suite error; otherwise it becomes the primary run error. It does
not rewrite already completed test statuses. Its runner-assigned category
determines exit 1, 3, or 4 under 06-cli.md.

The resolved test timeout starts after driver launch/session restore and covers
remaining test-scoped fixture acquisition, `beforeEach`, and the body. Each
teardown hook and finalizer has a separate
`cleanupTimeout` budget, default 30 seconds. Suite hooks use the config test
timeout. Cancellation is propagated to every active operation; cleanup still
runs with its bounded budget.

Test callbacks are not assumed to cooperate with cancellation. On timeout the
runner aborts fixture proxies and waits the cleanup grace period. If user code
does not settle, it terminates the execution realm. JavaScript `afterEach` and
`afterAll` hooks cannot run after forced realm termination; only host-owned
finalizers run with a fresh cleanup signal. The report marks cleanup `forced`
and retains the timeout as primary.

## Setup tests

A setup test statically declares every session it produces:

```ts
test.setup(
  'authenticate as admin',
  { sessions: ['admin'] },
  async ({ app, agent, session }) => {
    await app.open();
    await agent.act('Sign in', {
      user: credentials.user('admin').username,
      password: credentials.user('admin').password,
    });
    await session.save('admin');
  },
);
```

For each target, a session name MUST have exactly one selected producer.
Missing and duplicate producers are collection errors. A setup test runs once
per selected target per runner invocation, subject to its retry policy. It MUST
save each declared session exactly once and MUST NOT save undeclared names.
Names are 1 through 128 ASCII letters, numbers, `_`, `-`, or `.`.
Captured outputs are staged inside the setup attempt and become visible only
after the complete setup body and teardown succeed. A failed attempt publishes
no session.

If setup ultimately fails, its dependent tests are skipped with
`setup-failed`; unrelated tests continue. The setup failure itself contributes
to the run's failure status. A missing credential, model, driver, or session
capability is a configuration or infrastructure error rather than a skipped
dependency.

## Sessions

Sessions are immutable captured client state. In the web profile they include
cookies, local storage, and IndexedDB. They do not include server/database
state, open network connections, route handlers, tabs, or in-memory JavaScript
objects.

The setup-only `session.save(name)` asks the driver to capture state and writes
a `session-1` envelope. Ordinary tests have no imperative session API. The
static `session` option validates the selected producer and replaces current
client state; restore never merges. The driver then starts from a quiescent
context. Tests SHOULD call `app.open()` in `beforeEach` or the body after a
restore.

The `session` test option restores state after driver launch and before
`beforeEach`. For a serial group it restores once, before the first member of
the group attempt. It is not restored between members.

Session files live under `.e2e/sessions/<run-id>/` and are encrypted with
AES-256-GCM using a random per-run key held only in runner memory. All envelope
metadata is authenticated additional data. Owner-only storage is REQUIRED when
sessions are used; inability to enforce it is a configuration error. Writes are
atomic. Expiry is the earlier of a valid driver expiry and `createdAt + 24h`;
without driver expiry it is exactly `createdAt + 24h`. Driver expiry at or
before creation is a setup failure.

Each active run holds an advisory lease lock inside its run directory. Startup
scavenging first holds the session-root maintenance lock and removes only
expired directories whose lease can be acquired non-blocking. Concurrent active
runs are never removed. Files are deleted during cleanup; abandoned ciphertext
is undecryptable after its in-memory key is gone.

A session is rejected unless run ID, schema, target ID, driver ID/version/SPI,
platform, app identity, and expiry all match. v0 never reuses sessions across
runner invocations.

## Serial groups

A serial group is one scheduling and retry unit:

1. Create a fresh execution realm, driver session, fixture graph, and ledger.
2. Restore the group's session once, if configured.
3. Execute members in declaration order, including each member's hooks.
4. Preserve app state, module variables, and the ledger between members.
5. On a member failure, skip remaining members for that attempt.
6. If retries remain, close the entire attempt and restart from member one in
   a fresh realm and driver session.

The outermost `serial: true` group defines the unit. Nested serial groups and
setup tests inside it are collection errors. Members cannot override `session`,
`platforms`, `requires`, `retries`, `skip`, or `only`; those options belong to
the unit. Member tags, timeout, and agent context may differ.
Its source ID is `serial::<normalized-relative-file>::<encoded-group-title-path>`
using the same normalization as test IDs. A report serial-group ID is SHA-256/
JCS of `{ serialId, targetId }`, avoiding collisions across targets.

Only a completely successful group attempt passes. A group that succeeds
after retry is `flaky`; reports retain every member and artifact from every
attempt. `report-1` has a first-class serial-group record. Its group attempt ID
is the exact driver `attemptId` and owns shared launch, cleanup, and artifacts.
Each group attempt contains ordered member-execution records with unique IDs
`<group-attempt-id>:member:<member-index>`, steps, errors, and skip causes.

Ordinary test results for serial members contain `serialGroupId` and no
independent attempts; their status is derived from the group's member history.
A member not reached after a predecessor failure is `skipped` with cause
`serial-predecessor-failed`. If a later complete group attempt passes, the group
and every member are `flaky`, even when an earlier member itself passed before a
later member failed. Without a final successful group attempt, each member uses
its status in the final group attempt.

A group excluded or pre-skipped before launch still has one serial-group record
with `status: skipped`, the filter/skip cause, and zero attempts. Every member
result references it, has the same skip cause, and has zero attempts.

## Retry and result rules

A retry always reruns fixture acquisition, session restore, hooks, and the
test body in a clean logical attempt.
A timed-out or cancelled attempt is never reused.

| Failure phase/category | Test retry eligible | Realm action |
|---|---:|---|
| `beforeEach`, body, or `afterEach` test failure | yes | discard, fresh realm |
| test timeout | yes | force cleanup/discard |
| `beforeAll` or `afterAll` failure | no | fail suite instance/discard |
| configuration, collection, policy setup | no | do not launch |
| driver/provider/artifact/cleanup infrastructure | no | discard worker |
| internal invariant | no | abort run |
| process signal/user interruption | no | interrupt run |

`afterEach` failure is primary only when no earlier phase failed; otherwise it
is secondary. A cancelled operation caused by a test timeout uses the timeout
row. Runner-created cancellation without a timeout is infrastructure failure.

An ordinary test is `passed`, `failed`, `timed-out`, `interrupted`, `skipped`,
or `flaky`. `flaky` means at least one failed attempt followed by a pass. Prior
attempt errors and artifacts MUST remain in the report. Exit status is based on
the final outcome, while policy MAY separately reject flaky results.

## Cleanup

Acquisitions register finalizers immediately. Finalizers execute once in LIFO
order within their owning scope. Driver sessions, routes, dialogs, downloads,
artifact recorders, app child processes, temporary sessions, and dynamic
resources MUST close after pass, failure, timeout, cancellation, and process
signal. Cleanup failure is reported and affects run status according to
06-cli.md.

## Deferred

`globalSetup`, `globalTeardown`, `test.each`, conditional skips, custom
fixtures, sharding, watch mode, and clock control are post-v0.
