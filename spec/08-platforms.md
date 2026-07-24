# 08 - Targets and Deterministic Surfaces

`web-0.1` defines web execution. The canonical source API is
[`api/e2e.d.ts`](./api/e2e.d.ts); the normalized backend contract is
[`api/driver.d.ts`](./api/driver.d.ts).

## Targets

A target is one named execution environment. Every explicit target has a
unique required `name`, a platform ID, and a driver. With no target config the
runner creates `web` using `APP_URL`, Chromium, and the reference Playwright
driver.

```ts
export default defineConfig({
  targets: [
    { name: 'chromium', platform: 'web', browser: 'chromium' },
    { name: 'firefox', platform: 'web', browser: 'firefox' },
  ],
});
```

Each test-target pair has an independent result. Target names are stable IDs
in reports, caches, sessions, and artifact paths.

Platform IDs and capabilities are separate. `platforms: ['web']` filters by
platform. `requires: ['web']` filters by the web capability and can therefore
include a future Electron target. Drivers publish capabilities before launch.

## Portable and capability surfaces

The universal portable test fixtures are `agent`, `app`, `screen`, and
`platform`. Setup tests additionally receive the state-backed `session` writer.
A driver profile MUST implement each universal fixture and its declared state
capability. Family
capabilities are separate fixtures: `web` for web semantics and, in a future
profile, `device` for mobile system controls.

A third-party family augments `TestFixtures` and returns its runtime object
under the same capability name. Capability IDs MUST be globally namespaced
unless standardized here; for example `acme.tv`, not `tv`.

## Query model

Creating a locator performs no I/O. Each locator is an immutable expression
containing a query, scope, filters, and optional index. The runner sends the
complete expression to the driver; it never persists a node reference as a
locator or cache entry.

The query vocabulary is closed in `sdk-0.1`: role, label, placeholder, text,
display value, and test ID. Cached query selection prefers role, label,
placeholder, text, display value, then test ID. Priority affects cache
generation only; all query methods are equally valid.

### Text

Text normalization and exact/regexp behavior follow 03-assertions.md. A string
query is exact unless `exact: false`. A regexp uses its ECMAScript source and
flags. Global and sticky regexp state is reset before every match.

### Web semantics

For `web-0.1`:

- roles and role ownership follow WAI-ARIA 1.2;
- accessible names follow Accessible Name and Description Computation 1.2;
- `hidden` defaults to false and excludes nodes hidden from the accessibility
  tree;
- label queries use associated `<label>`, `aria-label`, and `aria-labelledby`;
- placeholder queries use the exposed placeholder string;
- text queries use rendered descendant text and exclude script/style content;
- display-value queries use the current form-control value;
- test ID uses `screen.testIdAttribute`, default `data-testid`.

Role states use computed accessibility state, not the mere presence of a DOM
attribute. Unsupported state on a role does not match. `disabled` includes
native disabled state and `aria-disabled=true`.

### Cardinality

An unindexed action or single-node read requires exactly one match. With zero
matches, actions poll until their deadline and direct reads fail immediately.
With multiple matches, both fail immediately with `LOCATOR_AMBIGUOUS`.
`first`, `last`, and `nth` explicitly resolve ambiguity. `nth` is zero-based;
an out-of-range index behaves as zero matches. `count` resolves once and never
waits for a nonzero value.

Web matches use composed flat-tree document order. A scoped query examines
descendants and does not include the scope node itself. `filter({ hasText })`
matches normalized descendant text; `filter({ has })` evaluates the nested
expression relative to each candidate. Both filters are conjunctive when
present, and an empty filter object is an immediate error. Cyclic locator
expressions and negative indices are errors.

## Waiting and actionability

The runner owns query, matcher, URL, and condition polling. `resolve` and
`read` in `driver-1` are immediate. This rule overrides backend defaults and
ensures one timeout model across drivers.

The driver owns actionability for one already resolved node. For web, an
actionable node is attached, visible, stable for two consecutive animation
frames, enabled when applicable, and able to receive the requested input at its
action point. Fill additionally requires an editable control. The driver's
actionability wait consumes the runner-supplied operation deadline.

The default action timeout is `config.actionTimeout`, 30 seconds, capped by the
remaining test timeout. An explicit action timeout replaces that value but
cannot exceed the remaining test timeout.

If a node becomes stale before dispatch, the driver throws retryable
`NODE_STALE` and the runner re-resolves while time remains. Once input may
have been dispatched, the driver throws `ACTION_MAY_HAVE_COMMITTED`; the runner
MUST NOT repeat that action inside the same attempt.

## Locator reads and actions

The declarations in `api/e2e.d.ts` are the complete v0 set. Direct reads are
snapshots and do not retry for a desired value. Assertions and `waitFor` are
the retrying surfaces.

`fill` replaces existing content. Reading `inputValue`, text, or a
value-bearing attribute from a secure node rejects with `POLICY_DENIED`; it
never reveals or returns a mask for the secret. `press` uses the Web UI Events key value.
`selectOption({ index })` is zero-based. `dragTo` resolves source and target
uniquely in one revision and verifies both nodes are actionable before dispatch.
`scrollIntoView` succeeds when any part of the node is inside the viewport.

Scroll direction is from the user's perspective. `momentum: none` moves 50% of
the active scrollport over 250 ms, `slow` moves 75% over 500 ms, and `fast`
moves 150% over 250 ms, capped by the remaining scroll range. Default momentum
is `none`. `scrollTo` defaults to down with slow momentum and fails
`LOCATOR_NOT_FOUND` after two consecutive unchanged screen fingerprints.
Viewport and locator swipes start at 75% and end at 25% of the relevant axis;
the inverse applies for up/left, with the same durations.

`screen.scrollUntilVisible` defaults to direction down and slow momentum. If
the target currently resolves inside a scroll container, it scrolls the nearest
scrollable ancestor; otherwise it scrolls the viewport. It checks visibility
after each movement and fails after timeout or two unchanged screen
fingerprints. An explicit direction replaces down.

## `app` in the web profile

- `open()` navigates to the target base URL. A relative path resolves with the
  URL constructor against that base. An absolute URL must pass origin policy.
  It waits for `load` by default.
- `restart()` closes active pages and opens a fresh page, waiting for `load`, while preserving
  cookies, local/session storage, IndexedDB, cache storage, and service-worker
  registration in the logical context.
- `clearState()` clears those persisted stores, permissions, and service
  workers, then opens the base URL and waits for `load`.
- `back()` performs one browser-history traversal and waits for commit then
  `load`. No history is a successful no-op.
- `deepLink()` is equivalent to allowed absolute navigation in `web-0.1`.
- `screenshot()` returns an artifact-root-relative POSIX path after security
  masking. During pixel taint or when redaction cannot be proven, it rejects
  with `POLICY_DENIED` rather than returning a path.

Driver launch starts quiescent with no app page opened. UI operations before
`app.open`, `web.goto`, or equivalent navigation fail with `APP_NOT_OPEN`.

## `web`

`web` contains deterministic browser-only capabilities. Tests using it SHOULD
declare `requires: ['web']`.

### Navigation

Relative URLs resolve against the target base. All navigation is origin-policy
checked before dispatch and after redirects. `networkidle` means no active
network requests for 500 ms, excluding WebSocket/event-stream connections.
`waitForURL` uses runner polling and the assertion timeout unless overridden.
`web.goto` defaults to `waitUntil: 'load'`. `reload`, `back`, and `forward`
always wait for commit then `load`; a missing history entry is a successful
no-op.

### Selectors and frames

`web.locator` accepts CSS selectors. XPath requires an explicit `xpath=`
prefix. Invalid syntax is an immediate test error. `frameLocator` accepts a CSS
selector that must resolve to exactly one frame; each nested query is encoded as
a canonical `frame` locator-expression node. Cross-origin frames are queryable
only when their origin is allowed.

The driver owns immediate intermediate frame cardinality because a flat final
node list cannot represent it. Zero frame matches throws retryable
`FRAME_NOT_FOUND` for runner polling; multiple matches throws non-retryable
`FRAME_AMBIGUOUS`. Final element cardinality remains runner-owned.

### Evaluation

`evaluate` runs trusted test-provided source, never model-provided source. Its
argument and result MUST satisfy the `JsonValue` declaration and therefore
cannot contain a `Secret`, function, date, bigint, DOM node, symbol, non-finite
number, or cycle. Page exceptions preserve their message and mapped test source
location without exposing page secrets.

### Route matching

Regexp patterns use ECMAScript semantics. String patterns match the complete
URL with this grammar: `*` matches within one path segment, `**` crosses `/`,
`?` matches one character, and `\` escapes the next character. Other
characters are literal.

Routes are attempt-scoped and newest-first. The first matching handler owns the
request and MUST call exactly one of `fulfill`, `continue`, or `abort`. Returning
without a decision fails the attempt. Handler failure aborts the request and
fails the attempt. `unroute` removes all equal patterns in the current attempt.

Request authorization and cookie headers are redacted from reports by default.
Network bodies are never included in model observations.

`fulfill` accepts either JSON, a text body, or neither. JSON must be `JsonValue`.
Supplying neither produces an empty body. Default status is 200. Supplying both
forms is a type and runtime error.

### Events and downloads

Dialog handlers are registered asynchronously, are attempt-scoped,
newest-first, and are removed automatically. The returned async disposer is
idempotent. The first active handler decides. An unhandled dialog fails the
attempt. If an operation is active it rejects immediately; otherwise the driver
latches the failure, aborts pending waits, and the runner fails before the next
test statement can complete.

`waitForDownload` registers the waiter before running its trigger. The returned
path is artifact-root-relative and contained beneath the attempt directory.
Temporary backend paths are never exposed.

Cookies supplied with `url` derive domain/path from that URL. Cookies supplied
with `domain` default path to `/`. `expires` is a Unix timestamp in whole
seconds; omission creates a session cookie. URL/domain origins must satisfy app
policy.

## Observation consistency

Agent observation is one `Observation` envelope with a single revision,
timestamp, screenshot, semantic tree, viewport, and redaction result. A driver
MUST NOT return a screenshot and tree from observably different UI revisions.
Node references include that revision and expire when it changes.

If the UI changes during capture, the driver retries capture within the
operation deadline. It fails rather than returning mixed evidence.

## Future mobile profiles

The `Device` declaration and iOS/Android target shapes reserve source-level
vocabulary only. Mobile execution, accessibility projections, deep-link
mapping, permission behavior, application identity, and destructive-device
safety require dedicated profiles and conformance vectors before mobile release. A v0
runner rejects configured mobile targets instead of skipping them.
