# Run the test-authoring experiment

This private package prepares the historical forty-session comparison, the harder baseline study, or the connected study with six calibration attempts before twelve baseline slots. It grades returned E2E tests and starts no authoring model. The offline controls exercise the built `e2e` CLI and real Chromium without model credentials.

## First pilot result

The [forty-session pilot](results/pilot-2026-10-17.md) produced no observed detection gain. Both arms provisionally detected all twenty assigned regressions. An external transcript analysis observed lower-test source reads in nineteen treatment sessions and no baseline sessions. Attribution is exploratory AI review; the required human judgments remain pending. The result does not support promoting the treatment into production guidance.

The [harder baseline feasibility check](results/feasibility-2026-10-18.md) retained all twelve first attempts. Nine submissions passed the correct app and failed the changed app. Three sessions hit the token cutoff, and no slot produced a qualifying miss. Admission remains `unresolved`; a sixty-run comparison has not started.

The [connected calibration](results/connected-calibration-2026-10-18.md) passed its 144 preparation checks, then retained six author attempts. A journal-reader defect and an incorrect validation invocation blocked calibration. No baseline budget was sealed, and that bank's twelve baseline slots remain unstarted.

The [fresh connected calibration](results/connected-calibration-2026-10-19.md) repaired those execution problems and passed a new 144-check qualification. Three completed suites passed both correct-app replays. A process-observation failure invalidated the fourth calibration slot and stopped the schedule. That bank's twelve baseline slots remain unstarted.

The [completed connected baseline](results/connected-baseline-2026-10-19.md) uses a separately declared operator and bank. All six calibration authors passed both correct-app replays, and all twelve baseline authors completed within the sealed budget. All 72 grading cells are retained. Two correct-app repeats are unusable, and twenty member attributions await human judgment. All 48 changed-app repeats failed. Those failures do not establish intended detection or an inspection benefit. The result remains `unresolved-operational-feasibility`, and no sixty-run comparison ran.

## Prepare the inputs

Build the packages and install Chromium from the repository root.

```sh
pnpm build
pnpm --filter @e2e-dev/web exec playwright-core install chromium
```

Either command returning a nonzero exit code means setup failed.

The child app command resolves `node` through `PATH`. If you invoke the CLI with an absolute Node path, also put that Node executable's directory on `PATH`.

Create a settings JSON file outside the repository. This example declares synthetic controls and must not be used to claim real authoring results.

```json
{
  "purpose": "synthetic-controls",
  "allocationSeed": 42,
  "author": {
    "model": "synthetic-no-model",
    "launcher": { "name": "offline-control", "version": "1" },
    "settings": { "temperature": null, "seed": null },
    "tools": ["read", "shell"],
    "budget": { "maxTurns": 10, "maxTokens": 10000, "wallTimeSeconds": 600 },
    "unsupportedSamplingControls": ["temperature", "seed"],
    "isolation": "cooperative-only"
  }
}
```

For a real pilot, set `purpose` to `pilot` and declare the actual model, launcher version, settings, tools, budget, unsupported sampling controls, and isolation. The settings file describes intended authoring inputs. It is not evidence that a provider applied them.

```sh
pnpm authoring:eval prepare --out /tmp/authoring-private --settings /tmp/authoring-settings.json
pnpm authoring:eval summarize --experiment /tmp/authoring-private
```

Preparation must print `Prepared 40 fresh sessions`. A nonzero exit code or a missing forty-run plan means preparation failed. The initial summary must show twenty pending authoring sessions per arm and zero detections. A nonzero exit code or different pending counts means that check failed.

Preparation freezes the repository revision and worktree digest, lockfile, exact settings file, generated fixture inputs, full current skill/reference tree, common task, treatment paragraph, built package trees, copied dependency bundle, Node version, and observed Chromium version. It also records each lower-test result. Repeating preparation with identical inputs preserves the plan bytes. Conflicting inputs or edited prepared projects require a new directory.

The private `plan.json` schedules four fixtures, two arms, and five fresh sessions per fixture and arm. It shuffles twenty matched pairs with the declared seed. AB and BA starts are balanced ten to ten. Run IDs are opaque random values. Both arms receive the same project, task, dependencies, and available tool declarations. Only `.agents/skills/e2e/SKILL.md` gains the treatment paragraph. The complete reference tree stays the same.

## Run fresh authoring sessions

Deliver only one project from `author/<opaque-run-id>/<project-name>` to each new session, following the private plan order. Deliver `TASK.md` as the prompt. Restrict the session to that project, the same tools, and the same budget for both arms. Do not expose the allocation map, evaluator, hidden mutations, or another session's work.

These directories are not sandboxes. The dependency closure is copied from public built packages. Its relative links stay inside each project's `node_modules`; none points into this repository. Filesystem permissions still allow a process to leave its directory. A real restricted pilot requires an external container or another enforced filesystem and network restriction. Cooperative operation is explicitly labeled in the settings. The grader's syntactic checks provide no security guarantee, and the runner executes test code with its OS authority. Use no secrets or write tokens.

Return a separate directory containing exactly these files.

```text
tests/requirement.e2e.ts
authoring.json
transcript.jsonl          optional
```

The test must be one self-contained UTF-8 file. It imports only unaliased `test` and `expect` from `@e2e-dev/web` and `e2e`. Use deterministic UI actions and assertions. Application imports, other packages, filesystem inspection, runtime AI, dynamic imports, computed member access, skips, browser scripts, and explicit network APIs are outside this pilot's contract. The syntax guard checks common forms of those operations. It does not prove their absence against adversarial code.

Keep supplied app, config, requirement, lower-test, skill, and dependency files unchanged. Local `.e2e` output and the returned files are allowed. The grader checks protected input hashes before accepting a submission.

The external launcher writes `authoring.json`; the author returns only the test. Use the shape below. Copy `settingsHash` and `author` from the private plan without exposing the allocation fields to the author.

```json
{
  "settingsHash": "<plan.settingsHash>",
  "sessionId": "<unique external session ID>",
  "attested": {
    "freshSession": true,
    "projectOnly": true,
    "author": "<replace with the complete plan.settings.author object>"
  },
  "observed": {
    "usage": { "turns": 8, "tokens": 8500, "wallTimeSeconds": 412.5 }
  }
}
```

Collect observations before the first `grade` import. The record becomes immutable with the test. Later edits to add usage or reorder JSON keys are rejected even when the edited metadata has the same meaning.

Put launcher-observed `model`, `settings`, `tools`, and `budget` fields under `observed` when available. These describe the effective settings and budget limits, not consumption. The grader rejects observations that differ from the declaration. JSON object key order does not affect metadata comparison. Array order does.

Put actual authoring consumption under `observed.usage`. `turns` and `tokens` are nonnegative integer totals for the session. `wallTimeSeconds` is the nonnegative elapsed authoring time in seconds and permits fractions. Collect the complete session totals, including every authoring model call and tool interaction within the measured session. Use `null` for each unavailable measurement. If the launcher measures no consumption, omit `usage` or supply all three fields as `null`. Do not substitute the declared limits or the submitted test's runtime usage. For example, a partially measured session can return `"usage": { "turns": 8, "tokens": null, "wallTimeSeconds": 412.5 }`.

The external launcher owns measurement and budget enforcement. These observations do not prove which provider applied the settings or independently establish freshness, tool enforcement, or attestations. Reused session IDs are rejected. Include `"transcript": "transcript.jsonl"` only when returning that file. Transcripts and usage remain private and never enter blind review packets. Lower-test file reads remain unmeasured because this package has no transcript parser. Self-reported reads earn no credit.

## Grade and review returned tests

```sh
pnpm authoring:eval grade --experiment /tmp/authoring-private --run <opaque-run-id> --submission /tmp/returned-test
```

A nonzero exit code means import or execution orchestration failed. An `unusable` execution means grading did not establish a pass or test failure. The command preserves submitted bytes once. A changed submission under the same ID is rejected, including a changed authoring record.

Grading runs those exact bytes in two fresh copies of the correct project. One copy receives the evaluator-only hidden mutation. Both runs use the copied built CLI and web engine, separate app processes and output, one worker, zero retries, cache off, and no configured runtime model. Child environments exclude inherited service credentials and use a separate home directory. Raw reports, traces, screenshots, stdout, and stderr remain under opaque `work/` paths.

Give a reviewer only `packets/<opaque-packet-id>`. The packet includes the current requirement, exact test bytes, and correct/changed execution evidence. It excludes the arm, author record, transcript, copied skill, and private plan. Evidence text removes repository and experiment paths. Author-supplied test text remains unchanged, so do not put model or arm labels in it. Reviewers must remain blind to the allocation map.

Record judgments in a JSON array.

```json
[
  {
    "packetId": "<packet.packetId>",
    "evidenceHash": "<packet.evidenceHash>",
    "reviewer": "<human reviewer>",
    "verdict": "intended-bug",
    "reason": "<which UI assertion demonstrates the current requirement violation>",
    "synthetic": false
  }
]
```

Verdicts are `intended-bug`, `unrelated-failure`, or `uncertain`. Mark offline control decisions `synthetic: true`. A synthetic decision is never counted as a pilot detection. The summary rejects duplicate, unknown, changed, or mismatched review evidence and preserves each accepted judgment.

```sh
pnpm authoring:eval summarize --experiment /tmp/authoring-private --reviews /tmp/reviews.json
```

A nonzero exit code means the decision import or evidence check failed. Read `reports/summary.json` and `reports/summary.md` for the joined results. Subsequent summaries retain accepted judgments without requiring the input file again.

Every selected test must pass the correct app. Correct-app failures and rejected test contracts are invalid authored tests. No tests, skips, setup failures, run errors, malformed reports, and timeouts never score detections. Infrastructure cases remain pending execution. Passing the changed app is a miss. Failing it remains pending review until a human attributes the failure to the intended bug. Unrelated and uncertain failures receive zero credit.

Each imported session also receives a budget state. `within` requires every usage measurement to be known and at or below its corresponding limit. Equality with a limit is allowed. `exceeded` means at least one known measurement is above its limit, even if another measurement is missing. That run is invalid and earns zero detection credit. `unknown` means no known overrun exists and at least one measurement is missing. A reviewed intended failure with unknown compliance stays pending budget measurement and earns zero usable detection credit. Its evidence stays archived. Because imports are immutable, collect the missing observations before import or start a new experiment to replace an incompletely measured pilot.

Both summary files report actual per-run consumption and budget states. The JSON also includes each run's declared limits. The historical summary's per-arm and per-fixture aggregates show the known count, missing count, and sum of known measurements for each usage metric. The total is `null` in JSON and `unknown` in Markdown when no measurement is known. Partial sums are never estimates for the missing sessions. Unknown budget counts include scheduled sessions that have not returned a submission.

## Check the evaluator offline

```sh
pnpm authoring:eval grade --experiment /tmp/authoring-private --controls
pnpm --filter @e2e-dev/test-authoring test
pnpm --filter @e2e-dev/test-authoring typecheck
```

Each command returning a nonzero exit code means its check failed. Historical controls must return twenty-seven rows. Harder controls return thirty-six rows. The package test must report passing historical and feasibility checks with no failures, and the typecheck must finish without diagnostics. Root `pnpm test` includes this package after building the public packages. The test suite removes its temporary projects unless `AUTHORING_KEEP_CONTROLS=1` is set.

Each fixture runs strong, weak, unconditional-throw, unrelated-locator, empty-suite, and broken-server controls through the real built CLI. The cart fixture also exercises skipped tests, setup failures, and timeouts. Strong tests pass the correct app and reach their specific failing UI assertion on the mutation. The other controls receive no detection credit. Explicitly synthetic decisions exercise the review join and never enter the forty-run pilot comparison.

| Fixture | Public lower tests | Hidden regression |
|---|---|---|
| Cart | Passing arithmetic checks | Displayed total stays stale after quantity changes |
| Wiring | Passing validation helper checks | Visible submit bypasses the helper |
| Stale test | One intentional failure against the obsolete minimum of five | UI restores that obsolete minimum |
| No relevant test | Passing unrelated title-formatting check | Reservation confirmation never appears |

The historical summary uses twenty scheduled sessions per arm and five per fixture and arm. Invalid authored tests stay in that denominator with zero credit. Pending and invalid counts remain visible. A proposed promotion appears only after all forty pilot submissions have reviewed, resolved outcomes and known budget compliance. Known overruns remain in the fixed denominator with zero credit. Missing usage blocks completion and promotion even when a test otherwise has a resolved outcome. The rule requires more detections overall, improvement on at least two fixtures, and no decline on stale-test or no-relevant-test fixtures. This is a proposed decision rule, with no statistical significance or generalization beyond this corpus and declared authoring setup.

## Prepare the harder baseline feasibility study

```sh
pnpm authoring:eval prepare --study harder-baseline-feasibility --out /tmp/harder-private --settings /tmp/harder-settings.json
pnpm authoring:eval summarize --experiment /tmp/harder-private
```

A nonzero exit code, a missing v2 plan, or a count other than `Prepared 12 fresh sessions` means preparation failed. The initial summary must show twelve scheduled and missing sessions, two per fixture, with `unresolved` admission. A nonzero exit or different counts means reporting failed. These commands start no authoring model.

This study freezes six complete products with passing lower tests. Checkout, adjacent bookings, cancellation capacity, and dependent postal validation are informative fixtures. Versioned cancellation policy and saved preferences are safeguards. Authors receive PRODUCT.md, app source, lower tests, the current installed skill, and the same organic task. All twelve slots use the current arm. Baseline authors may inspect lower tests voluntarily. No treatment paragraph is appended.

Preparation runs all thirty-six synthetic controls before sealing the plan and copying author projects. Every strong control must pass the correct app and fail the changed app at its expected UI assertion. Every weak competing journey must pass both versions with matching selection. Negative controls receive no credit. The plan binds private corpus.json and admission-controls.json. Later changes to the live harder registry cannot reinterpret a frozen v2 study. Historical plans still use their unchanged four-fixture registry.

Use the same fresh-session, external isolation, exact-submission, grading, and blind human-review procedure described above. The package does not launch models or enforce their budget. The external launcher must preserve every first attempt. Missing output, invalid contracts, unusable execution, and unknown or exceeded usage remain in the fixed denominator.

Feasibility admission requires correct-app-valid execution and known budget compliance in all twelve sessions. It also requires a qualifying miss in at least two informative fixture families. A qualifying miss has matching nonempty test selection and passes both app versions within budget. Unrelated failures and safeguard misses never establish informative headroom.

The report returns `admitted` when those conditions hold, `not-admitted` when a complete usable set lacks headroom, and `unresolved` when a measurement or validity condition is missing. Changed-app failures awaiting human attribution remain separately visible. Admission does not establish instruction benefit or authorize a sixty-run comparison. No command prepares that comparison.

## Run the connected baseline feasibility study

The separate `authoring:connected` command creates a v3 bank for six connected product tickets. The historical `authoring:eval` commands and v1/v2 results retain their existing meaning. This stage schedules six calibration first attempts and twelve baseline first attempts. It creates no treatment or comparison authors. The baseline can inspect ordinary lower tests voluntarily.

Each supplied project README includes the [browser test constraints](connected/browser-authoring.md), and its task links to them. These constraints disclose the submission guard's exact imports, excluded identifiers and property names, and ban on computed access, including array indexing. They apply to the returned suite in this study. They are not restrictions of the E2E package itself.

Build the public packages and install Chromium with the setup commands above. The connected package consumes their built output. It does not build or install through a dependency symlink. The external native operator must implement the exact [version 1 JSON contract](operator-wire.md). Its settings file declares the actual author model, effort, effective sampling controls, tools and frozen operator source hash. It also names the exact predeclared calibration-rule JSON file.

```sh
pnpm authoring:connected prepare --out /tmp/connected-private --settings /tmp/connected-settings.json
pnpm authoring:connected verify-bank --experiment /tmp/connected-private
pnpm authoring:connected summarize --experiment /tmp/connected-private
```

Each command returning a nonzero exit code means validation or orchestration failed. Preparation must report six calibration identities, twelve prospective baseline slots and 108 verified control launches. `verify-bank` must report 36 lower launches, 108 control launches and `allPassed: true`. The initial summary must retain twelve unstarted slots and ordered gate 2, `unresolved-operational-feasibility`. A different count, absent evidence, or zero selected tests fails the corresponding check.

Preparation freezes exact public product and task files, source reconstruction bytes, the complete installed consumer skill, lower-test discovery and counts, two single-location patches per ticket, literal controls, weights, seeds, runtime packages, observed Node and Chromium versions, and all eighteen prospective IDs. It runs each lower suite on correct and both changed images twice. Strong and meaningful weak suites each run on all three images twice. Wrong expectations, unrelated assertions and startup failures each run on the correct image twice. These are 108 real copied-CLI control launches. Preparation retains every result and refuses to freeze a failed or inconsistent bank. A repaired design needs a new retained directory.

Five isolated shop projects use the same complete correct product runtime. The expense ticket uses its applicable product rules. Public project roots contain ordinary app files, lower tests, instructions and copied built dependencies. They contain no private study records or variant settings. Each app owns mutable `.data/` saved state. The operator may also create `.e2e/`, `.home/`, `.tmp/` and the returned test. All supplied inputs remain protected.

The operator first proves deterministic native MCP, boundary, lifecycle and copy behavior against an actual prepared project. This admits the six authorized calibration attempts with attached author shell use explicitly pending. A successful ordinary attached native shell workflow from an actual calibration attempt supplies a separate immutable workflow proof before baseline sealing. A spawned shell outside the native author workflow does not satisfy this proof. Natural supervisor cleanup and owned-finalizer cleanup remain separate recorded observations.

```sh
pnpm authoring:connected validate-calibration --experiment /tmp/connected-private --run CALIBRATION_ID --submission /tmp/connected-private/exports/calibration/CALIBRATION_ID
pnpm authoring:connected seal-baseline --experiment /tmp/connected-private
```

Each command returning a nonzero exit code means that calibration validation or baseline sealing failed. `validate-calibration` also exits nonzero when the exact returned suite fails either predefined correct-app launch. Its result contains no changed-app or variant fields. It never runs calibration suites against a variant. All six complete usage records and two passing correct launches per suite are required. A cutoff, missing output, unknown usage, invalid suite or infrastructure failure stops baseline admission. The study never estimates from a valid subset or replaces an attempt.

Calibration ceilings are 64 completed responses, 2,000,000 full reported tokens and 1,200 authoring seconds. Token totals include cached and repeated input. `maxTurns` and `turns` count unique completed model responses. Let T be the maximum complete token total, P the largest completed response token total, R the maximum completed response count and W the maximum authoring interval across all six. Baseline limits are `100000 * ceil((2*T + P)/100000)` tokens, `max(32, 2*R + 2)` responses and `60 * ceil(max(600, 2*W + 60)/60)` seconds. These limits provide an operational reserve and no guarantee against cutoff. The sealed plan binds all six sources, the workflow proof, common budget and twelve baseline IDs before any baseline author starts.

Author concurrency is one. Timed authors run without grading, builds or integration suites alongside them. The operator preserves each exclusive started marker, terminal failure, full raw reported usage, response-level totals, raw events, export and cleanup evidence. Reactive cutoffs can overshoot. A late complete usage observation cannot change an authoritative cutoff into a completed author. The grader permits equality with a limit and reports known overruns only above it.

```sh
pnpm authoring:connected grade --experiment /tmp/connected-private --run BASELINE_ID --submission /tmp/connected-private/exports/baseline/BASELINE_ID
pnpm authoring:connected summarize --experiment /tmp/connected-private
```

A nonzero `grade` exit means import or orchestration failed. Read its explicit admission and execution states even when the command exits zero. The grade records two correct launches and two launches per changed member. Missing, rejected and cutoff attempts contain six explicit nonexecution cells. Every launched cell uses a fresh copied public project, built packages, an independent app process and browser context, one worker, zero retries, cache off and no runtime model. Connected tests use the ordinary supplied 60-second test timeout. The runner stops test scheduling after 180 seconds. The evaluator interrupts the copied CLI at 240 seconds, then allows a bounded cleanup interval. A timeout or incomplete selection is unusable evidence and earns no detection credit. A locator failure by itself does not establish infrastructure failure or intended relevance.

The private `supervise-cell --project PATH [--deadline-ms N]` diagnostic runs that same copied CLI with a deadline of at most 240,000 milliseconds. It records observed descendant PID/start identities and listening endpoints in sealed `process.json` evidence. POSIX hosts need `ps` and `lsof`; Windows hosts need PowerShell process and TCP metadata. Missing metadata fails the launch. The supervisor interrupts its owned CLI, observes natural cleanup, then finalizes only identities whose start value still matches. A successful finalizer does not erase a deadline or natural cleanup failure.

The study retains exact returned test bytes, reports, text traces, screenshots, CLI output and reconstruction hashes. It can release only newly created disposable dependency copies after recording their hashes and cleanup receipts. It preserves the source runtime bundle and historical artifacts. A repeated command reuses completed cells and refuses conflicting inputs. An interrupted predefined launch remains an interruption and is never retried to obtain a preferred result.

Each member receives an opaque packet containing complete PRODUCT.md and TASK.md, the exact authored test and both correct and changed repeats. Packet manifests describe path scrubbing and any identified attachment that could not be sanitized. An unknown attachment containing a private identity is omitted with its hash and reason in the manifest. Other unknown formats block packet completion until reviewed. Full raw evidence remains private. Packets exclude operator receipts, usage, transcripts, lower-read observations, slot/session identities and private joins. Human reviewers receive only packet directories.

```json
[
  {
    "version": 1,
    "kind": "human",
    "packetId": "<opaque packet ID>",
    "evidenceHash": "<packet evidence hash>",
    "reviewer": "<human reviewer>",
    "verdict": "intended-bug",
    "reason": "<relevant observable UI assertion and public rule>"
  }
]
```

Human verdicts are `intended-bug`, `unrelated-failure`, `qualifying-miss`, `nonqualifying-miss` and `uncertain`. A passing changed suite still requires a human to decide whether it protects a real user goal and qualifies as a miss. An intended detection requires two passing correct launches, two consistent changed failures, matching nonempty selection, complete common-budget compliance and relevant human attribution. Exploratory AI records have a separate `kind: "exploratory-ai"` schema and cannot fill required human judgments.

```sh
pnpm authoring:connected summarize --experiment /tmp/connected-private --reviews /tmp/connected-human-reviews.json
pnpm authoring:connected summarize --experiment /tmp/connected-private --ai-reviews /tmp/connected-ai-reviews.json
```

Each command returning a nonzero exit means record import or evidence validation failed. Summarization preserves accepted judgments and writes reports/summary.json and reports/summary.md. A successful command can report unresolved feasibility. The ordered gate first rejects an independently rejected design. It then keeps any missing, invalid, cutoff, unjudged, inconsistent or unknown evidence unresolved. Only a complete usable judged set can produce observed ceiling, qualifying distributed headroom in at least two informative families, or insufficient qualifying headroom. Orders and wishlist remain safeguards. Every report keeps all twelve slots, suite-level fractions and correlated member outcomes visible. `comparisonAuthorized` is always false.
