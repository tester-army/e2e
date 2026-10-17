# Run the test-authoring experiment

This private package prepares forty independent authoring sessions and grades their returned E2E tests. It starts no authoring model. The offline controls exercise the built `e2e` CLI and real Chromium without model credentials.

## Prepare the inputs

Build the packages and install Chromium from the repository root.

```sh
pnpm build
pnpm --filter @e2e-dev/web exec playwright-core install chromium
```

Either command returning a nonzero exit code means setup failed.

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

Both summary files report actual per-run consumption and budget states. The JSON also includes each run's declared limits. Per-arm and per-fixture aggregates show the known count, missing count, and sum of known measurements for each usage metric. The total is `null` in JSON and `unknown` in Markdown when no measurement is known. Partial sums are never estimates for the missing sessions. Unknown budget counts include scheduled sessions that have not returned a submission.

## Check the evaluator offline

```sh
pnpm authoring:eval grade --experiment /tmp/authoring-private --controls
pnpm --filter @e2e-dev/test-authoring test
pnpm --filter @e2e-dev/test-authoring typecheck
```

Each command returning a nonzero exit code means its check failed. Controls must return twenty-seven rows. The package test must report seven passing tests, including five nested subtests and the metadata policy test, and the typecheck must finish without diagnostics. Root `pnpm test` includes this package after building the public packages. The test suite removes its temporary projects unless `AUTHORING_KEEP_CONTROLS=1` is set.

Each fixture runs strong, weak, unconditional-throw, unrelated-locator, empty-suite, and broken-server controls through the real built CLI. The cart fixture also exercises skipped tests, setup failures, and timeouts. Strong tests pass the correct app and reach their specific failing UI assertion on the mutation. The other controls receive no detection credit. Explicitly synthetic decisions exercise the review join and never enter the forty-run pilot comparison.

| Fixture | Public lower tests | Hidden regression |
|---|---|---|
| Cart | Passing arithmetic checks | Displayed total stays stale after quantity changes |
| Wiring | Passing validation helper checks | Visible submit bypasses the helper |
| Stale test | One intentional failure against the obsolete minimum of five | UI restores that obsolete minimum |
| No relevant test | Passing unrelated title-formatting check | Reservation confirmation never appears |

The summary always uses twenty scheduled sessions per arm and five per fixture and arm. Invalid authored tests stay in that denominator with zero credit. Pending and invalid counts remain visible. A proposed promotion appears only after all forty pilot submissions have reviewed, resolved outcomes and known budget compliance. Known overruns remain in the fixed denominator with zero credit. Missing usage blocks completion and promotion even when a test otherwise has a resolved outcome. The rule requires more detections overall, improvement on at least two fixtures, and no decline on stale-test or no-relevant-test fixtures. This is a proposed decision rule, with no statistical significance or generalization beyond this corpus and declared authoring setup.
