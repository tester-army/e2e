# Debugging a failing run

Paths below sit under the configured `output` directory; `.e2e` is the
default.

## Contents

- Read the failure
- Hosted-session debug export
- Error codes
- Tools
- Flaky tests
- Is it the app?

## Read the failure

1. Every failure in the `list` output ends with `❯ trace
   .e2e/results/<test>/trace.md`. Open that trace page: `Look at:` (the line it unwound
   through), `Expected:` / `Observed:` (an `expect`), `Asked for:` and
   `Waited:` (a locator), whether every attempt failed alike (a bug, not a
   flake), then every step with what it did under it:
   - the node an action landed on (`tap button "Save" (12ms)`), or `✗` and
     its code;
   - what an assertion read while it waited (`expect gave up after 16 reads
     in 1.6s: text "0 remaining" (1 match) x16`); one value throughout
     points at a wrong expectation, a broken app, or one slower than the
     timeout, changing values at a race;
   - what the app logged meanwhile (`✗ network error: POST /api/save 500`,
     `✗ uncaught error: ...`, `⚠ console warning: ...`, `ℹ console: ...`);
     `❯ app 2 errors` in the terminal says there are some, and the page's
     `## App log` lists up to 50 with their step, errors and warnings
     first, counting the rest;
   - where the page went (`↪ navigated to /login`, a new tab the app
     opened, a frame that loaded);
   - how the screen changed since the step before (`screen: 2 changes since
     step 3` with the added, removed, and changed nodes); `unchanged` after
     an action means it had no visible effect;
   - the cache's decision for an agent step: replayed, handed off and where
     (`at action 2 of 3, tap button "Apply": ...`), what became of the
     recording, and the entry file;
   - the agent's last turns, loop-guard notes included, and the
     accessibility tree at failure, one node per line.
   Fix from what was there. `trace` (default `retain-on-failure`) chooses
   which tests keep a page; `--trace` keeps one for every test of a run.
2. `.e2e/report.json` holds the same facts for scripts, not for reading:
   each step's `events` (`engine`, `poll`, `navigation`) and the attempt's
   `appLog` (each line's `step` is a step `index`) are what the page's step
   lines are rendered from, before it filters and caps them.
3. When a script needs them:

```bash
jq '.run | {status, exitCode, errors}' .e2e/report.json
jq '.run.results[] | select(.selected and .status != "passed") | {titlePath, file, status}' .e2e/report.json
jq '.run.results[] | select(.selected and .status != "passed") | .attempts[-1]
    | {status, error, failure, steps: [.steps[] | select(.status != "passed") | {api, label, source, status, error}], artifacts}' .e2e/report.json
```

   `error.details` holds the facts, `error.source` the line, `failure` the
   `url`, `screen` and `screenshot` artifact ids, and `candidates`; a
   failed agent step has `turns`; `selected` drops filtered-out tests
   (recorded as `skipped`).
4. Artifacts, under `.e2e/results/<test>/attempt-<n>/` (`rerun-<n>/attempt-<m>/`
   for a `--last-failed` rerun), beside the
   trace page: `screen-at-failure.txt`
   and the engine's screenshot per failed attempt; downloads; with
   `--video` the recording (`video/video.webm` in a local browser, each
   later page `video/video-part<n>.webm` with its own `startedAt`;
   `video/video.mp4` on a device; a provider's file or link); with
   `--debug` every agent step's transcript.

## Hosted-session debug export

For a session from `openHost` in `e2e/runner`, await `session.close()` and
check its failures. Then `session.exportDebugBundle()` returns the same frozen
`session-debug-1` snapshot each time, even after timeout, cleanup failure, or
trace-write failure. It is `undefined` before close settles. Final redaction
waits for cleanup and worker retirement, but teardown returning is not proof
that a provider finished. Actual resolution calls drain using only the
remaining cleanup window; unused providers are not invoked. A pending or failed
resolution withholds all potentially secret-bearing prose as
`[text withheld: secret resolution unproven]` and content artifacts as
`incomplete-redaction`. Configured opaque providers also make prospective
publication unproven: recovery or later disposal can BEGIN a fresh getter call.
Even prior completion does not certify its next value. Prose and evidence paths
are withheld before the first trace write, including partial temporary-file
writes. Effective literal/environment values still use known-value redaction.
No eager getter calls or extra waits establish this proof. Enum/status tokens,
validated SDK IDs, timings and counters remain structural facts. Later provider completion cannot change the frozen
snapshot or rewrite its trace. With provider-valued secrets,
previously cut text whose redaction cannot be proven becomes
`[text withheld: truncated before final redaction]`, even for a short prefix.
Field lengths are bounded after final redaction; raw text is not kept to
recover truncated logs, turns, or errors. Verdict summaries redact known
values before their 2,000-character cap and mark producer cuts explicitly.
Only declared closed SDK tokens and structural facts at exact protocol
positions bypass prose redaction, including `run.runner.name: e2e` and validated
SDK identity/timing joins.
Matching words in labels, names, explanations, and external identity text
are still masked. Forwarded accepted-image byte totals must be nonnegative
safe integers, separate from peak image bytes; absent totals stay absent.
If masking changes a target origin, omit that optional URI. If it changes a
model endpoint, omit the optional model record (endpoint is required); never
invent a replacement address. Declared `local`/`provider-default` tokens stay.
Schema-unique arrays deduplicate after redaction, even for known-value
collisions; ordered steps, events, and turns retain repetitions.

Only the SDK's exact `run.runner.name: e2e` literal is preserved. Matching
target, fixture, session, agent, or external runner names remain prose.
Effective secret layers use descriptor-only accounting, seed every literal
before handoff, and never invoke getters to prove publication. Opaque history
is permanent even after successful resolution; missing accounting denies proof.
Hosted path selection and close also classify private effective definitions by
own descriptors. Accessors remain opaque without being read; only actual
requested resolution evaluates them.

A UUID/digest shape never exempts target names, external IDs, carried declarations,
or error details. Only exact SDK protocol identity locations and validated joins
retain generated IDs; masked target IDs still join result references.
Original SDK tickets plus registered-byte format checks prove PNG, UTF-8 text,
and checkpoint JSON media facts. Filenames and caller MIME claims do not.
PNG signature validation is not image decoding or masking proof. Proven MIME
facts survive coinciding secrets only in artifact media fields, not matching
prose. Unsafe unproven MIME rows and references are omitted, never turned into
fake media types.


Only the private SDK missing-checkpoint protocol can retain fixed unavailable
facts when opaque secrets deny content publication. It requires the original
sink-bound, unconsumed ticket, expected byte length and SHA-256, actual owning
attempt/step joins, original boundary timestamp, and a null capture association.
The timestamp must match the private association snapshot, not mutable public
registration fields. Before the first write and again after asynchronous reads,
the sink checks exactly nine boundary fields,
closed missing reasons, and canonical compact JSON with zero or one trailing LF.
Duplicate keys, discarded prose, extra fields, capture data and trailing bytes
are denied even with a matching receipt. This permission never covers generic
JSON, text, pixels, engine metadata or caller names. Registered checkpoint
recordedness is independent of retained-file availability. Consumers still own
hosting and later file rechecks. This exporter does not enable checkpoint capture.


- `report` reuses `report-1`: SDK outcome, identity, errors without stacks,
  step timings and events, bounded reasoning and tool turns when recorded.
- `artifacts` is the registration manifest. Copy only entries whose
  `evidence.status` is `available`; `evidence.path` resolves against
  `session.artifactsDir`. Before copying, recheck root containment, symlinks,
  size and SHA-256. Missing or withheld entries have a reason and no path.
  `not-retained` covers registrations without a retained path and actual ENOENT,
  the only filesystem-access error mapped to this reason. `read-failed` means
  I/O prevented verification, not missing or changed bytes.
  SDK pixels and semantic captures need a private capture-start ledger proof.
  Executor screenshots carry the original ticket and byte identity through sizing
  and persistence, with no extra observation. A private one-use byte receipt binds
  expected SHA-256 and length before writing; the sink checks actual persisted
  bytes before store publication or export admission. Attachment names use
  SDK nonces and exclusive creation, so colliding labels never share a file.
  Path-returning engine captures hold the original descriptor on return before
  the first yield and hash it asynchronously in bounded chunks;
  the original engine path and retention stay authoritative. Binding abandons its
  wait at the existing capture deadline or caller cancellation, without renewing
  the ticket. Issued reads may retain their stream-owned descriptor until safe
  cleanup. Ordinary contained
  engine filenames may include spaces or Unicode; hosted export still requires
  portable ASCII names. Binding permits symlink ancestors of a stable physical root but rejects
  a linked root entry, traversal, descendant symlinks, hard links
  and non-files without changing or restoring the engine path. Engines still own
  capture correctness. Consumer containment/hash rechecks
  remain necessary. Transcripts are ticketed after final
  known-value masking, before the first write. Opaque content is withheld before
  transcript/failure-summary writes; known-secret cut transcripts are also withheld.
  With configured literals, even complete prose such as `Waiting… done.`
  can be withheld: all earlier cuts lack a shared completeness contract.
  Do not strip markers to bypass this gate. Transcript bounds apply after
  masking at 262,144 UTF-8 bytes.
  Checkpoint JSON is ticketed after final field redaction. Original tickets
  are single-use and sink-bound. A bare marker or copied ticket is not proof. Evidence
  captured while resolution was pending, before later values joined the
  ledger, or without a capture proof is withheld. Opaque pixels and clipped
  prose cannot be repaired retrospectively. The trace uses this same
  allowlist before reading a log or linking a file. ArtifactStore completeness is
  not private export permission: genuine redacted ordinary CLI/MCP/serial transcripts
  stay complete. Unsupported custom pictures may retain truthful legacy store
  metadata under proven secrecy, but remain withheld from export. After async
  measurement, the sink rechecks live secrecy, ledger growth and pixel taint
  before any store handoff. Failed proof marks even local-only metadata incomplete
  and prevents a store handoff.
- Do not scan directories, parse Markdown, derive filenames from artifact IDs,
  or import private runner modules. Arbitrary consumer files, contributed
  attachments, downloads, external URLs and incompletely redacted recordings
  are not export paths. No automatic publication occurs.
- `evidence` records availability per step. Semantic summaries are bounded
  screen summaries/diffs. `checkpoints: recorded` means the SDK registered a
  checkpoint for that step, not that its file is exportable. An optional
  artifact `checkpoint` has `id`, `phase: before | after`, and
  `observationId: string | null`; `observationRevision` is the actual capture
  revision. Opaque IDs are nonempty, control-free, at most 1,024 UTF-8 bytes,
  never clipped or inferred from filenames or the last step revision.
  Unknown or unproven observation ID/revision are both null. Secret-bearing
  identity withholds the file and omits or nulls metadata, never invents a
  replacement. Ordinary captures omit the association and keep null revision;
  absent checkpoint registrations remain `not-recorded`. This export
  extension does not enable capture. Provider reasoning may be unavailable.
- `SessionDebugBundle`, `DebugArtifact`, and `ImmutableReport` are public types
  from `e2e/runner`. Validate with the shipped `session-debug-v1.schema.json`
  and its referenced `report-v1.schema.json`.

Your runner still owns reporting, retries, publication and external test-body
outcomes. Read the full contract in `docs/reference/runner.mdx`.

## Error codes

| Code | Usual cause | Fix |
| --- | --- | --- |
| `CONFIG_LOAD_FAILED` | The config throws while loading (a refused engine option is `INVALID_CONFIG` instead) or imports a missing package, subpath, or removed export such as `defineConfig` | Install the dependency, or fix the import or line quoted |
| `INVALID_CONFIG`, `INVALID_GLOB` | Unknown or foreign key (`app`, `webServer`, `use`, `projects`, `baseURL`), `json` with `list`; a `tests` glob with braces, classes, an absolute path, or no wildcard | The message names the key or glob to write; the app is declared in the target's `app` |
| `CONFIG_NOT_FOUND`, `CONFIG_AMBIGUOUS` | Wrong `--config` path; both `.ts` and `.mts` present | Fix the path; keep one |
| `NO_TESTS` | The glob, a positional, or a filter matched nothing; the message names each empty positional and each undeclared `--tag` with the nearest declared one | Check the config `tests`, the `.e2e.ts` suffix, the tag names |
| `NO_LAST_RUN` | `--last-failed` found no `.e2e/report.json` | Run once without it |
| `COLLECTION_ERROR` | `async` describe body, `test.setup` inside `describe`, an option forbidden in a serial group, registration outside collection | Restructure per `writing-tests` |
| `HOOK_FAILED` | `beforeAll` or `afterAll` threw; its scope's tests skip | Fix the hook; the report carries its error |
| `UNSUPPORTED_ARTIFACT` | A test's or target's `video` on an engine that cannot record | Drop it there, or set it at the config root or CLI (such targets skip with a notice) |
| `BROWSER_INSTALL_FAILED`, `LAUNCH_TIMEOUT` | Browser download failed; engine init or attempt start exceeded `launchTimeout` | Run the quoted `npx @e2e-dev/web install <names>` or `pnpm exec e2e-web install <names>` (`--with-deps` on bare Linux); raise the root `launchTimeout` (60 s default) |
| `APP_UNREACHABLE` | `app.command` never answered `readyUrl` within `startupTimeout`; on a device, a message naming the iOS automation runner: the runner failed, not the app | Read the quoted log lines; check the port, `app.url`, `app.command.env`, `app.command.startupTimeout`. Runner: rerun, else `npx agent-device daemon stop` and reboot the simulator |
| `APP_ALREADY_RUNNING` | Something already serves `url` when `command` should start | Stop it, or `reuseExisting: true` locally |
| `APP_URL_REQUIRED`, `APP_NOT_OPEN` | A navigation on a target without `app.url`; a `screen` call before `app.open()` | Add `app.url` to the target; open the app first |
| `INVALID_ARGUMENT`, `INVALID_LOCATOR` | A step argument failed validation; a locator got a bad option or filter key | Fix the call the code frame names |
| `LOCATOR_NOT_FOUND` | Wrong role or name, inexact text, element off screen or in an iframe, page not open | Read the markup for the accessible name; `exact: false` or a RegExp; `browser.frameLocator` for iframes; `app.open()` first; `--headed` |
| `LOCATOR_AMBIGUOUS` | Two matches (hidden duplicate, repeated label) | `{ name }`, a container scope, `filter`, `first()`, or `{ visible: true }` |
| `ASSERTION_FAILED` | Wrong expectation, or the state settles later than 5 s; for `agent.assert`, a false judgment (explained in the report) | Compare with the report's actual text or the screenshot; `{ timeout }` on the matcher; rewrite the question |
| `ASSERTION_INCONCLUSIVE` | `agent.assert` or `agent.extract` asked about what the screen does not show (another page, still loading, only in pixels); a failure, never a pass | `app.open()` or `agent.waitFor` the right screen first; ask about what is shown; `vision: true` when the answer is in pixels (the message says so) |
| `MODEL_OUTPUT_INVALID` | An `extract` or `assert` answer failed the schema after one repair round | Simplify the schema or question; pick a stronger model |
| `ACTION_FAILED` | Element not actionable (covered, disabled, detached), or an operation timed out | `expect` the condition first; close overlays; check `actionTimeout` |
| `TEST_TIMEOUT` | The attempt exceeded `timeout` (120 s) | Split the test, or raise `timeout` |
| `STEP_NOT_AWAITED` | The body returned while a step or `expect.poll` still ran, or an `afterEach` hook or fixture teardown returned while an `expect.poll` still ran: a call without `await` | `await` the call the code frame names (every `app`, `agent`, `screen`, `expect`, `expect.poll` call) |
| `MODEL_UNAVAILABLE` | `agents.<name>.model` holds no AI SDK instance: reported once under `run.errors` at the first `agent` fixture; the run stops. A model-less custom executor fails only `waitFor` and `extract` this way | Construct one, e.g. `gateway('openai/gpt-6-luna-fast')` from `ai`, and export its key (`AI_GATEWAY_API_KEY`) |
| `MODEL_PROVIDER_FAILED` | Network, 5xx, rate limit, no credits, or no response in 120 s, after the transport retries | Check the credential (the key; for keyless `gateway()` the Vercel CLI login and `.vercel/project.json`) and quota; retry (exit 3) |
| `REPLAY_STALE` | `--strict-cache` or `cache.strict`, and a committed recording no longer replays; `step.cache.reason` says why | Rerun read-write with the knob the message names off; commit the changed entry under the directory it names (a custom `cache.store` is written by that run) |
| `AUTOMATION_UNSUPPORTED` | The step needs an interaction the engine's toolset lacks (drag on a device, say); blocked, exit 1 | Do that step with `screen` actions, or run the test on a target that supports it |
| `STEP_TIMEOUT`, `STEP_BUDGET_EXHAUSTED` | Goal too big or ambiguous, or a slow provider | Split the goal, use on-screen wording, add vocabulary via `agents.<name>.context` or `agentContext`; raise `maxSteps` or `maxModelCalls` (budget), the config `timeout` (`act`), `judgmentTimeout` (judgments); `--debug` |
| `CONTEXT_OVERFLOW` | Screen plus step history did not fit the model's context window (`act` after one shrink-and-retry; a judgment on the first overflow) | Lower `agents.<name>.maxObservationBytes`, split the step, or pick a larger-window model |
| `POLICY_DENIED` | A URL whose scheme is not `http:` or `https:` (`file:`, `view-source:`, `data:`); a password `Secret` into a non-password sink; reading a secure field, `toHaveValue`, `toHaveText`, `toContainText`, `toHaveAttribute` included; `app.screenshot()` after a secret fill, or an `act` or `vision: true` step whose tree read timed out after one | http(s) or `about:blank` only; passwords into password inputs only; assert the outcome, not the value; screenshot before filling secrets |
| `UNSUPPORTED_CAPABILITY` | A fixture the engine lacks (`browser` on a device), `schema` or `vision` on `act`, an action the surface lacks | Declare `requires: ['browser']`; drop the option or action |
| `SESSION_UNAVAILABLE`, `SESSION_CONTRACT` | `session: 'x'` with no setup saving `x`; a setup that skipped a declared name. `SESSION_MISMATCH`, `SESSION_EXPIRED`, `SESSION_INVALID`: the stored session is another run's or app's, expired, or corrupt | Add or fix the `test.setup`; rerun it |
| `ONLY_IN_CI` | `test.only` reached CI | Remove it |
| `AUTH_CREDENTIAL_UNAVAILABLE`, `AUTH_CREDENTIAL_INVALID` | `credentials.user('x')` for an undeclared name; the app rejected a configured credential | Add it to `config.credentials`; fix the stored value |
| `SECRET_UNAVAILABLE` | `secrets.get('x')` for an undeclared name | Add it to `config.secrets`; `E2E_SECRET_X` only overrides a declared one |

## Tools

| Do | When |
| --- | --- |
| `--headed` | Watch the failing step |
| `--workers 1 --retries 0` | Take parallelism and retries out of the picture |
| `--no-cache` | Rule out a stale `agent.act` replay |
| `--debug` | Each agent step's duration, model calls, cost, transcript |
| `--ai-trace`, then `npx unbox-ai runs .e2e/ai-trace.json` | What the model saw and called |
| `--video`, `--video=retain-on-failure` | Watch the failed attempt; `step.startedAt` minus the segment's `startedAt` is the step's offset into it |
| `command.log: '.e2e/logs/app.log'` | The app's output when it never gets ready or errors mid-test |
| `await app.screenshot('before-submit')` | Evidence before a secret is filled; later calls fail with `POLICY_DENIED` |
| `CI=1 npx e2e run` | Reproduce CI-only behaviour (defaults: topic running) |

## Flaky tests

- A read (`textContent()`, `count()`) caught a value mid-update: use a
  matcher.
- Shared data: unique names per run, `afterEach` cleanup, or a `serial`
  group.
- App not ready: assert on the element you are about to use, not the
  previous page.
- An agent judgment asserts exact phrasing: judge the fact, add a
  deterministic `expect` beside it.
- Load timing: `retries` masks it; `--workers 1 --headed` shows it.
- Measure a fix: `npx e2e run <file> --repeat-each 10 --retries 0`
  (`--no-cache` for agent steps). `Repeats` reads `0 of 1 test passed all
  10 runs` over `3/10 passed · repeat 0 ASSERTION_FAILED · ...` (0-based)
  before, `1 of 1 test passed all 10 runs` after.

## Is it the app?

A deterministic step failing every run at the same place with the same code
is a product bug or a changed screen, not a flake: reproduce once with
`--headed`, then fix the app or update locator and expectation together. A
blocked agent step (`AUTH_CREDENTIAL_UNAVAILABLE`, `ENVIRONMENT_UNAVAILABLE`,
`SEED_DATA_MISSING`) exits 2 or 3 on purpose: fix the environment.
