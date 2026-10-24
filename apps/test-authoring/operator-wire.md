# Connected operator wire version 1

This reference fixes the JSON boundary between the connected study and its native operator. All JSON files use UTF-8, two-space indentation and a final newline. SHA-256 hashes cover exact bytes. A hash beside an immutable JSON file is `<filename-without-.json>.sha256` and contains its lowercase 64-character digest plus a newline. Paths inside records use `/`, remain relative to the private bank, and cannot contain empty segments, `.`, `..`, backslashes, drive prefixes, or Windows device names. IDs are 24 lowercase hexadecimal characters. Private records never enter an author project.

The study alone writes `bank.json`, `bank.sha256`, `corpus.json`, `settings.json`, `calibration-rule.json`, `source/`, `runtime/`, `snapshots/`, `projects/`, `author/`, `controls/`, `lower/`, `calibration/`, `plan.json`, `plan.sha256`, `grades/`, `submissions/`, `packets/`, `private-joins/`, `judgments/` and `reports/`. The operator alone writes `operator/admission.json`, `operator/workflow-proof.json`, their evidence, `attempts/`, and `exports/`. It does not change bank, plan, grades or calibration results. Existing first-attempt markers prohibit retry, resume or replacement.

## Settings and frozen bank

The settings input has exactly these fields. `model`, `effort`, tool names and effective sampling settings describe the actual author configuration. `operator.sourceHash` hashes an explicit frozen SOURCE_FILES map, using logical paths rooted at the new evidence directory. Paths cannot contain `..`. Keys use lexical order and values are exact file SHA-256 digests. The encoding is `JSON.stringify(map, null, 2) + '\n'`, equivalent to `json.dumps(already_sorted_map, ensure_ascii=False, indent=2) + '\n'`. Scripts, tests and operator-protocol.md are explicitly mapped. Proof logs and pycache are excluded by the explicit map. The operator retains its source manifest as evidence and verifies every mapped file before each launch. `calibrationRule` names the predeclared rule JSON file. Preparation copies its exact bytes. No configurable budget formula exists.

```json
{
  "schemaVersion": 1,
  "purpose": "connected-baseline-feasibility",
  "allocationSeed": 42,
  "author": {
    "model": "<actual model>",
    "effort": "<actual effort>",
    "settings": {},
    "tools": ["shell", "e2e"],
    "unsupportedSamplingControls": ["temperature", "seed"],
    "isolation": "externally-enforced"
  },
  "operator": { "name": "connected-native", "version": "1", "sourceHash": "<sha256>" },
  "calibrationRule": "<absolute predeclared calibration-rule.json path>"
}
```

`bank.json` has `version: 3`, `study: "connected-baseline-feasibility"`, `comparisonAuthorized: false`, `settingsHash`, `corpusHash`, `calibrationRuleHash`, `runtimeHash`, `controlsHash`, `lowerHash`, `source`, `operator`, `calibration`, `prospectiveBaseline`, `projects`, `repeats: 2`, `authorConcurrency: 1`, `controlLaunches: 108`. `source` has `repository`, `revision`, `cleanWorktree`, `contentHash`, `lockHash`, `node` and `chromium`. `operator` copies the declared operator object. `calibration` is six ordered `{id,fixture,order}` records, one per fixture. `prospectiveBaseline` is twelve ordered records of that same shape, two per fixture. These eighteen generated IDs are prospective and immutable before authoring. They are disjoint. The fixture IDs are `addresses`, `promotions`, `expenses`, `catalog`, `orders`, `wishlist`. `projects` maps each ID to its sealed project-manifest path.

`source.repository` is the absolute actual checkout path, private to the bank and operator. `source.revision` is its HEAD commit. `source.cleanWorktree` is true only when `git status --porcelain` returns no output. Development banks may be dirty for local verification. Author admission and every author launch require true and a current clean tracked and nonignored untracked tree at the same reviewed committed revision. The status check includes nonignored untracked files. The complete source map also binds every nonignored untracked input, so an untracked implementation change cannot escape the content guard.

`source/files.json` is a sealed map whose keys are the sorted unique output paths of `git ls-files -co --exclude-standard -z`. Each value has exactly `kind: "file"|"link"` and `hash`. A file hash covers its raw bytes. A source link hash covers the UTF-8 bytes of its raw link target. The source map encoding uses two-space JSON and a final newline, with keys in lexical order and value keys in the order `kind`, `hash`. `source.contentHash` hashes these exact `source/files.json` bytes. Each entry's raw bytes are retained at `source/blobs/<hash>`. The operator reconstructs the same current map, includes the complete current tracked and nonignored untracked census, and requires its digest to equal source.contentHash. `source.lockHash` covers the exact repository pnpm-lock.yaml bytes. `source.node` is Node's version string. `source.chromium` is the observed launched Chromium version.

`source/snapshot-<fixture>.json` is a sealed sorted path/hash map for its public snapshot, including the installed consumer skill. `source/patch-<variant>.json` has exactly `id`, `file`, `beforeHash`, `afterHash`, `replacementHash`, `ruleIds`, and `weight: 1`. These private files bind one source replacement. The bank's exact corpus already binds their source strings and rule mapping.

`runtimeHash` hashes the two-space JSON plus newline encoding of the lexical sorted runtime tree map. Regular file values hash raw bytes. A contained relative symlink value hashes UTF-8 `link:` followed immediately by its raw link target. Links must resolve inside that runtime root. Directory entries do not appear. The operator uses the same derivation for every copied runtime and protected-file map. No writable source or operator link may enter the runtime.

`projects/<id>.json` has exactly these fields. Its hash sidecar seals the manifest. The project contains only the complete public application, PRODUCT.md, TASK.md, README, ordinary lower tests, unchanged consumer skill and contained copied built dependencies. Source and dependency hashes are separate. `protectedFiles` includes every initial file and contained link. Mutable `.e2e/`, `.home/`, `.tmp/`, `.data/`, and `tests/requirement.e2e.ts` are excluded from protected-input comparison. The ordinary app server owns .data saved state. No other supplied input may change.

```json
{
  "schemaVersion": 1,
  "kind": "connected-public-project",
  "id": "<slot ID>",
  "phase": "calibration",
  "project": "author/<slot ID>/<ordinary-project-name>",
  "projectHash": "<sha256 of sorted protectedFiles JSON>",
  "protectedFiles": { "PRODUCT.md": "<sha256>" },
  "runtimeHash": "<sha256>",
  "settingsHash": "<sha256>",
  "sourceHash": "<source.contentHash>"
}
```

`phase` is `calibration` or `baseline`. Runtime and source hashes must match the bank. Source hashes cover repository file bytes, including the implementation being admitted. The bank stores reconstruction source manifests and exact public snapshots. Project names never contain a slot, fixture classification, variant, study or operator label.

## Operator admission

The immutable `operator/admission.json` has exactly `schemaVersion: 1`, `kind: "connected-operator-admission"`, `bankHash`, `operatorHash`, `sourceHash`, `runtimeHash`, `projectManifestHash`, `status: "pass"`, `checks`, `evidence`, `evidenceHash` and `cleanup`. `checks` is exactly the object below. `evidence` is a nonempty map of bank-relative evidence paths to exact file hashes. `evidenceHash` hashes its canonical sorted map. `cleanup` uses the common cleanup shape below. Deterministic admission must exercise an actual prepared project. A direct MCP stub does not satisfy `nativeMcp`. It permits the six authorized calibration attempts while actual model shell use remains pending.

```json
{
  "nativeMcp": true,
  "attachedShell": "pending-calibration",
  "privateReadDenied": true,
  "outsideWriteDenied": true,
  "wanDenied": true,
  "ptyAndTemp": true,
  "receiptFailureRetained": true,
  "copyIsolation": true,
  "diskCapacity": true
}
```

The study requires this admitted record before validating calibration. The operator verifies its tree hash before every launch. Natural supervisor cleanup and the owned finalizer remain separate facts.

The operator writes a separate immutable `operator/workflow-proof.json` after a calibration attempt demonstrates an attached native shell workflow on its actual prepared project. Its exact fields are `schemaVersion: 1`, `kind: "connected-attached-workflow-proof"`, `bankHash`, `admissionHash`, `operatorHash`, `sourceHash`, `runtimeHash`, `calibrationId`, `terminalHash`, `attachedShell: true`, `evidence`, and `evidenceHash`. Evidence must identify a successful actual native `command/exec` event and its ordinary attached shell output. A model-free spawned process, a direct MCP call, or an earlier cohort is insufficient. The proof's calibration terminal must be completed, input-valid, cleanup-valid and usage-complete. Baseline sealing requires this proof and all six valid correct-only calibration results. This uses an already authorized calibration attempt and adds no author attempt. The original pending admission record stays unchanged.

## Attempt records

Create `attempts/<phase>/<id>/started.json` exclusively before starting a session. It has exactly `schemaVersion: 1`, `kind: "connected-attempt-started"`, `phase`, `id`, `bankHash`, `planHash`, `settingsHash`, `projectManifestHash`, `operatorHash`, `admissionHash`, `sourceHash`, `runtimeHash`, `budget`, `author`, `startedAt`. `planHash` is null for calibration and the sealed plan digest for baseline. `author` exactly matches settings.author. `startedAt` is an ISO UTC timestamp. The fixed calibration ceiling is `{"maxTurns":64,"maxTokens":2000000,"wallTimeSeconds":1200}`. Baseline uses the exact sealed common budget.

`maxTurns` and usage `turns` count unique completed model responses. They never count top-level app-server turns, tool calls, UI steps or user messages. Token totals retain cached and repeated input. `>=` triggers a reactive operator cutoff. A known measured value `>` its declared limit is a grader overrun. Equality alone is within limits, but an authoritative cutoff remains cutoff regardless of late events.

Every started attempt ends in immutable `terminal.json`, including launch, export, receipt, cleanup and resource failures. It has exactly these fields. An absent or invalid terminal record remains visibly unresolved. It never implies a valid submission.

Any `attempts/<phase>/<id>/receipt-failure.json` marker is an unconditional admission veto, including a failure raised after canonical terminal bytes were already written. It vetoes a completed terminal, existing correct-only result, baseline seal and baseline grade. The study retains the failure source and reports receipt-failed. The operator never resumes or retries that identity. An empty or malformed failure marker still vetoes admission.

The final global veto markers are `operator/admission-failure.json` and `attempts/<phase>/evidence-failure.json`. Their presence vetoes official admission or phase consumption even when empty or malformed and even when canonical pass files exist. Either phase marker blocks baseline sealing. The study reports admission-failed or phase-evidence-failed for affected started slots, retains unstarted slots as unstarted with their failure reason, and lists every marker path and exact hash in reports/summary.json `operatorFailures`. Reporting may read past canonical bytes solely to preserve the frozen schedule, raw observations and authoritative stop reasons. It never converts them into admitted evidence. No marker permits an automatic retry or resume. Started-without-terminal and unsafe or unstarted operator ledger rows remain retained operator evidence.

```json
{
  "schemaVersion": 1,
  "kind": "connected-attempt-terminal",
  "phase": "calibration",
  "id": "<slot ID>",
  "startedHash": "<sha256>",
  "bankHash": "<sha256>",
  "planHash": null,
  "settingsHash": "<sha256>",
  "projectManifestHash": "<sha256>",
  "operatorHash": "<sha256>",
  "admissionHash": "<sha256>",
  "sourceHash": "<sha256>",
  "runtimeHash": "<sha256>",
  "threadId": "<unique native thread ID or null>",
  "sessionId": "<unique native session ID or null>",
  "model": "<actual model>",
  "effort": "<actual effort>",
  "status": "completed",
  "stopReason": "completed",
  "failure": null,
  "startedAt": "2026-10-18T12:00:00.000Z",
  "finishedAt": "2026-10-18T12:01:00.000Z",
  "usage": { "turns": 3, "tokens": 12345, "wallTimeSeconds": 60 },
  "usageComplete": true,
  "maxResponseTokens": 6000,
  "rawReportedUsage": {},
  "responses": [{ "responseId": "response-1", "totalTokens": 6000 }, { "responseId": "response-2", "totalTokens": 4000 }, { "responseId": "response-3", "totalTokens": 2345 }],
  "rawEvents": { "attempts/calibration/<id>/events.jsonl": "<sha256>" },
  "outputs": { "attempts/calibration/<id>/stdout.jsonl": "<sha256>" },
  "protectedInputs": { "beforeHash": "<projectHash>", "afterHash": "<projectHash>", "unchanged": true },
  "export": { "path": "exports/calibration/<id>", "testHash": "<sha256>", "filesHash": "<sha256>" },
  "cleanup": { "natural": "failed", "finalizer": "passed", "evidence": { "attempts/calibration/<id>/cleanup.json": "<sha256>" } }
}
```

The example omits no fields. Nullable fields above accept JSON null. `usage` always has three fields, each nullable when unknown. `responses` retains every uniquely identified completed response and its nullable nonnegative integer total. `rawReportedUsage` is unrestricted JSON and preserves the provider's complete reported usage. Its meaning is never reduced to the three normalized measurements. Complete usage requires normal completion, unique reconciled response totals equal to `usage.tokens`, response count equal to `usage.turns`, maximum equal to `maxResponseTokens`, and a measured author interval. Late observations cannot change `stopReason` or admit a cutoff.

`status` is `completed`, `cutoff`, `missing-output`, `invalid-output`, `launch-failed`, `export-failed`, `receipt-failed`, `cleanup-failed` or `resource-failed`. `stopReason` is `completed`, `budget-cutoff`, `wall-time-cutoff`, `model-error`, `tool-error`, `missing-output`, `invalid-output`, `launch-error`, `export-error`, `receipt-error`, `cleanup-error` or `resource-error`. `failure` is null only for completed or cutoff, otherwise a nonempty explanation. A successful terminal receipt requires nonnull thread/session IDs that are unique across attempts. The native protocol may use the same value for threadId and sessionId within one attempt. It also requires unchanged inputs, nonempty raw-event/output hash maps, complete usage, finalizer pass and a valid export. Cutoff, incomplete measurements or absent output never fabricate a returned test. A failure may preserve a partial `export` for audit; the study still excludes it from executable admission.

`protectedInputs.afterHash` may be null when a failed attempt could not observe the final protected tree. Its typed failure, authoritative stop reason and unavailable measurements remain reportable. A completed attempt and any executable submission require `unchanged: true` and both beforeHash and afterHash equal to the sealed projectHash. An unavailable final hash never admits a submission.

Cleanup has exactly `natural: "passed"|"failed"|"unknown"`, `finalizer: "passed"|"failed"|"not-run"`, and `evidence`, a nonempty path/hash map. An owned-finalizer pass does not change a natural failure into a pass.

An export contains exactly `tests/requirement.e2e.ts`. Its `testHash` hashes exact test bytes. `filesHash` hashes its full sorted file-hash map. Transcripts, raw usage and receipts stay under attempts, outside the export and author project. An admitted successful terminal is the only operator record the study can use as a returned first attempt.

## Calibration, plan and grading

`validate-calibration --experiment BANK --run ID --submission EXPORT` reads only a calibration identity and runs the exact suite on two correct copies. The study writes its immutable result to `calibration/<id>.json` with exact-byte SHA-256 in `calibration/<id>.sha256`. Its sealed result has `version: 3`, `kind: "connected-calibration-result"`, `id`, `bankHash`, `terminalHash`, `submissionHash`, `testHash`, `usage`, `maxResponseTokens`, `correct`, and `valid`. It has no variant, mutation, member, packet or defect fields. Nonexecuted correct cells have explicit reasons. `submissionHash` and `testHash` are null when no submission was admitted, never placeholder digests. `testHash` hashes the exact returned UTF-8 test bytes. The retained study copy is `submissions/<id>/tests/requirement.e2e.ts`. `submissionHash` hashes the lexical sorted file-hash map of `submissions/<id>`, encoded with two-space JSON and a final newline. Its sole key is `tests/requirement.e2e.ts` and its value is testHash. Therefore submissionHash equals the successful operator export filesHash. `terminalHash` hashes exact terminal.json bytes. Each plan.calibration[].resultHash hashes exact `calibration/<id>.json` bytes, not its sidecar or parsed JSON. All six results and full complete receipts are required. One invalid attempt stops baseline admission without retry or subset estimation.

`seal-baseline --experiment BANK` computes the frozen rule from all six admitted sources. The sealed `plan.json` has `version: 3`, `study`, `comparisonAuthorized: false`, `bankHash`, `admissionHash`, `workflowProofHash`, `settingsHash`, `calibrationRuleHash`, `calibration`, `budget`, `runs`, `authorConcurrency: 1`. `calibration` has six records with `id`, `terminalHash`, `resultHash`, `tokens`, `maxResponseTokens`, `turns`, and `wallTimeSeconds`. `runs` exactly equals bank.prospectiveBaseline. Baseline budget is `100000*ceil((2*T+P)/100000)`, `max(32,2*R+2)`, and `60*ceil(max(600,2*W+60)/60)`. These are operational reserve limits with no cutoff guarantee.

`grade` accepts only a baseline plan ID and the matching immutable operator export. It retains exact submitted bytes and all six execution cells, two correct and two per bank member. Rejected, cutoff and missing attempts have explicit nonexecution cells. The study alone writes grades, opaque review packets and private slot/member joins. Each packet contains full PRODUCT, TASK, exact test and both repeats of correct and changed evidence. It excludes slot/session/variant identities, operator records, usage, transcript and allocation. Human verdicts remain required. Exploratory AI verdicts use a separate record type and cannot satisfy them.

## Retention and failures

Keep every raw report, trace, screenshot, CLI stdout/stderr, source/test hash, receipt and source manifest. Fresh work copies use isolated reflinks and contained dependency links. Only newly created disposable dependency copies may be released after a sealed reconstruction manifest records their hashes and a cleanup receipt records the removed paths. Historical artifacts and source runtime bundles remain intact. A failed command returns a nonzero exit and retains its evidence. Insufficient disk, malformed records, inconsistent exits, zero tests, selection changes, timeouts, setup/run/cleanup errors and runtime model use never earn defect credit. A locator failure by itself remains eligible for human relevance attribution.
