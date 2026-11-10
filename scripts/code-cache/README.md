# Executable cache exploration

This branch prototypes exporting a confirmed recording as a standalone web test.
It does not replace the runner's cache or add a published API. No other repository
was inspected or changed. The implementation is in
`packages/e2e/scripts/code-cache-emit.ts`; the command is
`scripts/code-cache/export.ts`.

## Current design

Paths below are relative to the repository root. Core paths start in
`packages/e2e/src/`.

| Responsibility | Code and contract |
| --- | --- |
| Capture | `cache/recorder.ts`, `agent/actions.ts`: durable descriptors and ordered grammar actions, not observation IDs |
| Format | `cache/trace.ts`, `cache/trace-fields.ts`, `cache/trace-read.ts`: `trace-1` TypeScript union and runtime validator. There is no separate trace JSON Schema in `schema/` |
| Storage | `cache/store.ts`: `<cache.dir>/<SHA256>.json`, normally `.e2e/cache`; 1 MiB ceiling, validated reads, atomic writes, optional deletion, custom `CacheStore` seam |
| Identity | `cache/identity.ts`, `cache/template.ts`: canonical digests, normalized instructions, per-signature occurrence index, parameter templates |
| Step lifecycle | `agent/step-cache.ts`: read, precondition, replay, end-state verification, handoff, stage or evict |
| Attempt lifecycle | `cache/context.ts`: save only after a later verifying step; keep identical confirmed flows without rewriting |
| Replay | `agent/replay.ts`, `cache/relocate.ts`: fresh semantic observations and grammar calls, conservative matching, settling and bounded retries |
| Evidence | `cache/anchors.ts`, `cache/route.ts`: route and appeared/disappeared anchor delta, including values and states |
| CLI | `cli/cache.ts`, config and run flag handling: `cache ls`, `stats`, `clear`, cache directory, mode, strict mode, bypass |
| Reports | `run/steps.ts`, `report/build.ts`, list, markdown, trace and debug renderers; `packages/html-reporter/app/`: cache mode, reason, action counts, handoff detail, write result and model provenance |

Each envelope has `schemaVersion`, `createdAt`, and `payload`. The payload holds
ordered actions, executor identity, summary, optional model and key provenance,
start/end paths, appeared/gone anchors, end-wait budget and truncation marker.
Actions include node taps and variants, typing and secret handles, keys, selection,
checkbox state, uploads, drags, scrolling, navigation, resize, viewport points,
focused keyboard operations, and explicit unreplayable `tool` gaps.

The key includes project, test, target, platform, engine name and SPI version,
agent name and context digest, instruction, params, occurrence, app identity,
cache schema and replay policy. Engine package versions are intentionally absent.
`unique()` values become slots, including URI, form and slug spellings. Secret
values are absent from keys and recordings. Secret names remain.

Only `agent.act` is replayed. `assert` and `waitFor` remain live judgments and can
confirm prior actions; `extract` stays live but confirms nothing. Deterministic
assertions also confirm recordings. An attempt passing alone does not confirm a
recording. Interruption neither writes nor evicts. Unconfirmed implicated flows
are evicted when the store permits it.

Replay re-observes and relocates each target. It tries identity fields first,
then semantics without a test ID, then the shape of a minted test ID with position
constraints. Recorded sibling counts must still match. Container keys keep a
row's action with its row. Structural selectors are recorded but ignored by the
conservative matcher. Missing targets get settling retries; unresolved ambiguity
hands off. Coordinates use a relocated element's fractional box position or
require the original viewport. A missing main scroll region may become viewport
scrolling; a missing smaller region cannot.

Routes tolerate minted IDs while preserving literal route and query distinctions.
Mobile screen titles can be opaque locations. Anchors compare text, value and
states as well as identity. The recorder favors announcements, then leaves, then
containers, capped at eight per side. It suppresses volatile dates, timings,
minted tokens and some counts when stable evidence exists. It retains volatile
anchors if otherwise there would be no evidence. Alerts receive special handling.
Replay requires an actual delta or route movement, not a success message already
present before the action, and rejects newly unexpected alerts.

Replay waits for settling and the recorded end-state budget, bounded by the step
deadline with room left for agent recovery. A divergence hands the agent the
executed prefix, stop reason and uncertain action if one may have committed.
It resumes on the current screen. It must not blindly repeat that action.
Hard stops and cancellation propagate. Normal retry attempts skip reads and
record afresh. Strict retries still replay. Strict mode rejects stale recordings
with `REPLAY_STALE`, including matching provenance under another key, but a truly
new step can run live. Strict mode does not write.

Both web and mobile use this core path through the engine protocol. Engine
capabilities and semantic observations determine what can be recorded and replayed.
This is not a browser-only cache.

## Consumers and migration scope

- Public declarations expose cache configuration, stores, executor handoff and
  report types. A replacement affects custom stores as well as the filesystem.
- `packages/e2e/schema/report-1.schema.json` and its fixtures must change with any
  new report wire fields. Session reporting and downstream reporter consumers
  need compatibility checks too.
- Web and mobile benchmarks commit JSON under `.e2e/cache`. `benchmark.yml` uses
  strict replay. `mobile.yml` uses strict replay on Android and lenient replay
  on iOS. These are regression gates, not merely disposable performance caches.
- `docs/cache.mdx`, `docs/reference/config.mdx`, CLI, agent, reporter and error
  references, and `skills/e2e/references/` describe this behavior. Public changes
  must update these, their examples and generated plugin copies together.
- `.github/workflows/site.yml` documents that e2e.com reads `docs/` and the example
  registry from main and triggers a deploy hook on changes. That is the confirmed
  e2e-site dependency available in this repo. Site-specific rendering and imports
  remain unverified because this task excludes other repos.
- Published offline docs and consumer skills are copied during the e2e build.
  Updating the site alone would leave installed agents with obsolete guidance.

## Proposed replacement

Keep the recorder as an internal representation, then compile confirmed actions
into plain TypeScript. Store executable calls, not JSON disguised as a call to
`replayTrace`. Retain the original agent-authored test as the intent and fallback.
A generated function represents one `agent.act`, so fixture lifecycle and later
independent assertions stay in the original test.

Use a sibling directory such as `tests/checkout.recordings/`. A file could be
`submit-order.web.default.0.<short-signature>.ts`. Use a bounded sanitized title
for readability and a checked digest for collision safety. The signature identifies
the step; changing engine policy should update metadata in the same file rather
than rename every file. Exclude this directory from test discovery.

A proposed generated module shape, using existing public call syntax:

```ts
import { expect, type Screen } from 'e2e';

export const recording = {
  format: 'code-1',
  key: '<full context digest>',
  generator: 1,
} as const;

export async function run({ screen }: { screen: Screen }) {
  await screen.getByRole('button', 'Increment', { exact: true }).tap();
  await screen.getByRole('button', 'Increment', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
}
```

This shape is a proposal, not an implemented loader. Export metadata with fixed
field order and no execution during lookup. A static parser should inspect it
before loading. Compile and typecheck the selected module against the configured
engine's fixture types. Execute code only from the trusted test checkout, never
import executable artifacts fetched from an arbitrary remote JSON cache.

Keep the existing identity inputs initially, with `code-1` and a new policy
version. Matching metadata plus supported engine capabilities means a candidate
hit. Check its start precondition before mutation. Missing files are misses.
Changed instruction, params, app, context or contract invalidate it. A stale file
stays in place for review and diagnosis. Strict mode fails stale code; read-only
runs never rewrite it. Do not invalidate on formatting or an unrelated engine
patch release.

On divergence, capture the completed public operations and failed operation from
the runner's step journal. Pass the existing prefix/uncertain-commit information
to the agent on the current session. Do not restart the generated function.
Keep fatal and policy errors fatal. After a later independent assertion confirms
the repaired flow, generate a candidate replacement and a unified diff. Local
explicit record mode can atomically replace the file. CI should attach the diff
and fail stale recordings instead of editing committed tests. A manually edited
recording needs explicit replacement consent through the record command.

Use a fixed emitter, two-space indentation, LF endings, escaped literals, stable
import ordering and deterministic metadata order. Preserve action order. Sort
only independent metadata and anchor checks with a documented key. Omit timestamps,
model prose, random observation IDs and measured latency. Use params and secret
handles instead of their runtime values. Choose explicit configured wait budgets,
not newly measured durations. Equal output must leave the file untouched.

## Examples grounded in existing recordings

These excerpts omit envelope metadata. Proposed code snippets show the meaningful
actions and outcome checks; they are not claims of full anchor-policy equivalence.

The integration prototype records the counter fixture in
`packages/e2e/tests/helpers/fixture-app.ts` during its test:

```json
{"actions":[
  {"name":"tap","target":{"role":"button","name":"Increment"}},
  {"name":"tap","target":{"role":"button","name":"Increment"}}
],"endAnchors":[{"role":"status","name":"Counter","text":"2"}]}
```

```ts
await screen.getByRole('button', 'Increment', { exact: true }).tap();
await screen.getByRole('button', 'Increment', { exact: true }).tap();
await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
```

The committed login recording is
`apps/web-benchmark/.e2e/cache/d9508413b3c3bd9567d0277a312312d32c4a1770d65e8e789d3ba0298717e662.json`:

```json
{"actions":[
  {"name":"type","value":"tester@tester.army","target":{"role":"textbox","name":"Email"}},
  {"name":"typeSecret","secret":"benchmark.password","target":{"role":"textbox","name":"Password"}},
  {"name":"tap","target":{"role":"button","name":"Log in"}}
]}
```

```ts
import { secrets } from 'e2e';
await screen.getByRole('textbox', 'Email').fill('tester@tester.army');
await screen.getByRole('textbox', 'Password').fill(secrets.get('benchmark.password'));
await screen.getByRole('button', 'Log in').tap();
await expect(screen.getByTestId('success-message')).toHaveText('Logged in successfully');
await expect(screen.getByRole('button', 'Log in')).not.toBeVisible();
```

The secret handle and `fill` already exist. The full recording also carries test
IDs, placeholders and password purpose. Replacing that conjunction with only
role/name requires a deliberate matching policy, not a mechanical omission.

The committed coupon recording is
`apps/web-benchmark/.e2e/cache/7e416edb8b37f403cd14184fa4f662f78b1a861bd0bac454aed7785cd0e0932b.json`:

```json
{"actions":[
  {"name":"tool","summary":"tool type (run-time value)","derived":"whole-node"},
  {"name":"tap","target":{"role":"button","name":"Apply"}}
]}
```

There is no faithful deterministic conversion of this entry. It records that the
value was derived, not the read expression that produced it. The migration result
must be an unsupported diagnostic and a fresh recording request, never:

```ts
// Incorrect migration: this freezes a value observed in one run.
await screen.getByRole('textbox', 'Coupon code').fill('SAVE-1234');
```

A future recorder needs to preserve a deterministic read and its data dependency
before it can emit a variable followed by `fill(code)`.

## Gaps and API work

| Gap | Existing support and required work |
| --- | --- |
| Matching multiple descriptor fields and semantic fallback tiers | Public role, text, test ID, filters and nested locators exist. Add a documented conservative locator construction policy. Reject descriptors that cannot be represented without weakening identity |
| Row keys and positioned twins | Nested locators, `nth` and count assertions exist. Captured `within` is a container key, not necessarily a role/name query. Record a typed locator AST at observation time and guard counts before selecting a position |
| Minted IDs and normalized routes | Regex locators and web URL assertions exist. A portable `expect(app).toHaveLocation` with explicit route semantics is a candidate addition; avoid hiding heuristic matching inside an ordinary exact URL assertion |
| Delta evidence and unexpected alerts | Visibility, text, value, checked, selected and expanded assertions exist. No single public operation expresses the full simultaneous semantic delta. Expose a typed transition assertion or capture baseline observations and use a documented polling API. Keep this separate from agent judgments |
| Waits and settling | Public operations auto-wait, but replay also settles between actions and reserves fallback time. Decide which semantics belong in public actions and which belong in the runner's generated-step execution context |
| Points and scrolling | Engine capabilities differ. Preserve viewport guards, fractional element positions, main-region fallback, folded repeats and bounded scroll-until semantics. Do not replace them with unguarded coordinates or fixed sleeps |
| Derived values and project tools | A gap does not contain a program. Record authorized read expressions and dependencies, or leave the step agentic. Never invent source code for arbitrary tool mutations |
| Params and secrets | `unique`, `secrets.get`, opaque secret fills already exist. Add typed generated function arguments and preserve encoded substitutions without embedding resolved secrets |
| Partial fallback | Existing `ReplayedPrefix` is available to executors. Add runner support for journaling generated public calls, uncertainty and remaining budget within one agent step |
| Confirmation | Generated internal checks must not automatically become independent verification of their own recording. Preserve the outer later-assertion boundary |
| Store compatibility | `CacheStore` currently exchanges traces. Introduce a separate versioned code-artifact store with source digest and trust rules; retain old adapters during migration |

Most action verbs already have public equivalents. The difficult work is preserving
matching, evidence, recovery and trust semantics, not renaming `type` to `fill`.

## Migration

Add an explicit export command with dry-run diagnostics before switching defaults.
Validate old JSON with the existing reader. Emit only fully supported entries;
report every unsupported action, target, template or postcondition with its file
and action index. Never partially export a flow as if it were complete.

Verify generated candidates in fresh sessions with the original test's later
assertions. Prefer code when both formats exist, with explicit format selection
and no silent fallback from broken code to old JSON in strict mode. Keep legacy
reading for one deprecation window. Delete old entries only after verification
and review. Newly recorded unsupported flows remain JSON or live agent steps
until their semantics can be generated. Custom stores need a separate migration.

## Prototype results and limits

Run the exporter with:

```sh
node scripts/code-cache/export.ts input.json output.e2e.ts 'recorded flow'
```

It validates `trace-1`, emits a standalone test using only public imports, and
refuses to overwrite an existing output. It supports tap and fill, role/name or
text descriptors, appeared/gone visibility checks, and one unchanged static web
path. It escapes source literals and regexes. It rejects unsupported actions,
descriptor fields, truncated traces and parameter or secret placeholders. Output
contains no timestamp, executor provenance, summary or observation ID.

The integration test runs a scripted executor against the real counter fixture,
reads the resulting confirmed JSON, exports it, then runs the generated file
with `cache: 'off'` and no configured agent. It also runs the built CLI with
`--no-cache`. The CLI reports `1 passed`. A deliberately wrong expected result
fails. The generated source is checked into the integration test's snapshot.
Two unit tests cover deterministic escaping and rejection of unsupported inputs.

An initial attempt failed because a timed `Late arrival` button was captured as
an appeared anchor. The test now waits for that fixture control before recording.
This demonstrates a real migration hazard: observed delta does not establish
causality. The exporter conservatively requires every appeared anchor to be absent
before acting, whereas current replay needs at least one qualifying change.
That stricter rule makes the prototype unsuitable as a drop-in replacement.

Other limitations are deliberate: no automatic code-cache lookup, invalidation,
agent handoff, regeneration, mobile support, secret lowering or general migration.
Assertions run sequentially, not against one shared observation. The exporter
uses default assertion timeouts rather than the recorded end-wait budget and does
not detect unexpected alerts. It is a proof of code emission and execution, not
proof of replay-policy equivalence. The JSON cache remains unchanged.

Validation performed:

- Built `e2e` and `@e2e-dev/web` before execution.
- `node --test scripts/code-cache/emit.test.ts`: two tests passed.
- `pnpm --filter e2e exec vitest run tests/integration/code-cache-prototype.test.ts`:
  one integration test passed, including real browser execution and built CLI.
- `pnpm exec tsc -p scripts --noEmit` and `pnpm --filter e2e typecheck`: passed.
- Focused oxlint: passed.
- `pnpm check`: passed, including the full build, workspace typechecks, dead-code
  gate, documentation checks and generated artifact checks.

No live model, mobile device, site deployment or performance comparison was run.
No production runner or engine code changed, and no performance claim is made.

## Risks, estimate and recommendation

Executable caches change the trust boundary. Existing JSON is constrained data;
imported TypeScript can run arbitrary code, including at module load. Treat
committed recordings like tests, and keep untrusted remote cache data out of the
module loader. Source digests detect corruption but do not establish trust.

The largest correctness risks are weaker selectors, sequential assertions that
never held together, treating generated checks as independent confirmation,
repeating a partly committed action, and freezing runtime-derived data. Reviewable
source does not solve these on its own. Stable output also requires controlling
which actions and incidental anchors get recorded, not merely formatting them.

My estimate for one engineer familiar with this runner is 1 to 2 weeks for a
restricted web beta with code lookup, typed parameters, strict mode and candidate
diffs. Preserving the full replay policy, mobile behavior, custom-store migration,
reporting and documentation likely takes another 3 to 6 weeks. These are engineering
estimates, not measured delivery dates. Derived-value provenance may require a
separate design and can remain agent-only initially.

I recommend an opt-in beta limited to named web controls and explicit outcome
assertions. First specify how generated calls share the agent step's journal and
verification boundary. Then add hit/miss and strict-mode execution behind that
contract. Run converted benchmark flows alongside legacy replay before making code
the default. Keep unsupported recordings explicit rather than promising a universal
JSON-to-code conversion.
