# Code cache parity

The runner now supports `cache: { format: 'code' }`. The initial exporter in
this directory remains a separate, restricted experiment. The integrated format
lives in `packages/e2e/src/cache/code.ts` and uses `e2e/replay`.

## Execution contract

Code is a constrained, typed recording language. The runner parses it without
executing imports or arbitrary JavaScript, validates it with the same trace
validator, and feeds the result into the existing replay engine. There is one
matching, settling, outcome and recovery implementation for both formats.

```ts
// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [{"name":"Saved","role":"status"}],
    "endPath": "/profile",
    "executor": {"name":"default"},
    "startPath": "/profile",
    "summary": "Profile saved",
  },
  [
    replay.tap({"summary":"Save profile","target":{"name":"Save","role":"button"}}),
  ],
);
```

Production recordings also retain key and test provenance, observed outcome
states and values, gone anchors, wait budgets, and every target constraint.
Each recorded action has a typed `replay.<verb>` call. A compile-time exhaustive
map requires new action variants to get a corresponding replay operation.

This is interpreted replay syntax, not unrestricted test code. Arbitrary function
calls, comments inserted into the body, new imports or reformatting outside the
generated grammar are rejected. Values can be reviewed and edited in place.
Accepting general TypeScript would require a different trust model and is not
necessary for JSON feature parity.

## What shares the existing behavior

- Every action variant, including mobile keyboard, coordinates, relative box
  positions, scroll repeats, scroll-until, uploads, modifiers and secret fills.
- Exact identity constraints, semantic fallback, minted test-ID shapes, container
  keys, sibling counts and ambiguity rejection.
- End-state checks against one observation, route normalization, actual transition
  evidence, unexpected alerts and volatile-anchor treatment.
- Settling retries, recorded wait budgets, cancellation and fatal-error handling.
- Partial replay handoff, uncertain commits, agent continuation and confirmed repair.
- Parameter slots and URI/form/slug expansion. Derived-value and project-tool gaps
  stay explicit handoffs. JSON never contained a deterministic read expression for
  these, so code does not invent one or freeze a runtime value.
- Cache keys, misses, invalidation, stale-key diagnosis, retries, read-only mode,
  opt-out and strict mode. A genuinely new step remains live under strict mode.
- The later independent verification boundary. The code's outcome checks do not
  count as an independent assertion confirming their own recording.
- Reports retain the existing cache and model provenance fields. No wire schema
  change was needed.

## Files, stability and migration

Files use the existing full identity digest with `.replay.ts` instead of `.json`.
`e2e cache ls` names their test, target and instruction. Context keys have stable
ordering; action and anchor order stay intact. Literals are escaped. No recording
timestamp or random observation ID is generated. App data needed for matching is
preserved, including IDs or dates the app displays; removing such evidence would
weaken replay. Existing `unique()` templating handles run-specific test data.

The existing same-flow comparison suppresses rewrites caused only by summary,
model provenance or measured end-wait changes. Unchanged hits preserve file bytes
and modification time. A real changed flow regenerates its source atomically and
saves a deterministic sibling `.replay.ts.diff`. `e2e cache diff` displays it.
Commit the source file, not the local diff sidecar. Diffs are explicitly requested
rather than dumped into every reporter's stdout.

`e2e cache migrate` converts validated JSON without deleting originals. It skips
existing code, reports invalid or oversized input, and names retained handoff gaps
and truncation. Each valid committed web and mobile recording converts without
losing any field used by replay. Select `format: 'code'` after migration. Only the
selected format participates in lookup, so invalid code cannot fall through to
legacy JSON and hide a strict-mode failure.

Custom stores continue to exchange `ActionTrace` through `CacheStore`. Setting
`format` on a custom store is rejected because the file format belongs to the
filesystem implementation. No remote executable-artifact loader was introduced.

## Verification

The existing `trace-replay`, `trace-cache-replay` and `agent-trace-cache` suites run
for both JSON and code. This covers recovery, strict mode, key changes, replay
without a model, template expansion, end-state checks, coordinates, cache modes,
confirmation, eviction and retries. The storage format is the variable; behavioral
assertions are shared.

The final shared parity and CLI run passed 180 tests across four files. Another
153 cache, confirmation, format and skill tests passed. Focused CLI/config tests
passed 44 tests, and the final format/CLI recheck passed 21 tests. These groups
overlap, so the counts should not be added. Public SDK type assertions and the
final `pnpm check` gate passed, including builds, lint, dead-code, workspace
typechecks, docs, plugin copies and package checks.

Additional tests cover all 30 web and 39 mobile committed recordings' round trips,
malicious expressions and appended code, invalid syntax, migration, unchanged
writes, regeneration diffs, read-only operation, CLI migration/list/diff/clear,
config rejection and public replay input types.

Live built-CLI checks used copied cache directories and unchanged committed JSON
as migration input. No committed benchmark recording was rewritten:

```text
Web: debounced-search and stale-dom
 Test Files  1 passed (1)
      Tests  2 passed (2)
      Cache  2 replayed

iOS simulator: Bottom Tabs
 Test Files  1 passed (1)
      Tests  1 passed (1)
      Cache  1 replayed
```

Both ran with `format: 'code'`, read-only mode and strict mode. The iOS run used
the installed benchmark app on iPhone 17 Pro, iOS 26.5. The first launch was blocked
by our inspection session's device lease; closing that session let the runner
acquire its own lease and pass.

No live model was needed for these benchmark hits. Scripted executors exercise
fallback and self-healing in integration tests. Android device execution, all
mobile scenarios and a live-model repair were not run. No performance improvement
is claimed; the comparison here is JSON versus code behavior on the same build,
not a main-versus-branch timing experiment.

## Remaining choices

No product decision blocks the opt-in implementation. It preserves today's
runtime-derived-value fallback rather than adding new provenance inference.
Supporting arbitrary editable TypeScript, looser formatting, prettier filenames,
or deterministic derived-value programs would be additional features. Keep code
opt-in while users review the generated grammar and trial their committed suites.
