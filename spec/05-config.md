# 05 - Configuration

The canonical config declaration is `E2EConfig` in
[`api/e2e.d.ts`](./api/e2e.d.ts). Unknown keys are errors. A future extension
must augment `E2EConfig` with a namespaced typed key before a runner accepts it.

## Project root and loading

`--config <path>` selects an explicit config. Otherwise the runner starts at
the current working directory and searches each parent for `e2e.config.ts` or
`e2e.config.mts`, stopping after the repository root. Finding both names in one
directory is an error. The selected file's directory is the project root. With
no config, the current working directory is the project root.

All config paths, globs, app-command working directories, artifact paths, and
test IDs resolve from the project root. Paths are normalized to `/` only in
wire formats; filesystem operations use native paths.

Config and test modules run as ESM. v0 supports standard ECMAScript plus
erasable TypeScript syntax and source maps. It follows Node package exports and
ESM resolution. It does not promise CommonJS globals, legacy decorators,
TypeScript `paths` rewriting, or runtime type checking. A runner MUST print the
original TypeScript source location for load and execution errors.

## Minimal config

`targets` is REQUIRED and there is no implicit target: the runner knows no
platform, so every target names the backend that serves it. The smallest
useful config is one web target on the playwright backend from
`@e2edev/playwright`:

```ts
import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  app: { url: 'http://localhost:3000' },
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
});
```

The effective base URL is `app.url`, then `APP_URL`; it is REQUIRED once a test
calls `app.open()` and optional otherwise. There is no target-level URL
override. `readyUrl` defaults to the effective base URL. The runner passes the
resolved app URL, origin policy, and query context to every backend's `init`.

The base URL uses WHATWG URL parsing/serialization and MUST NOT contain
userinfo, query, or fragment. A base URL without a scheme gets `https://`, or
`http://` when its host is loopback, so `tester.army` and `localhost:3000` are
both accepted as written. Host uses IDNA ASCII form and default ports are
removed. Its pathname is normalized for dot segments and retained as the app
base path.

`app.identity` is an optional stable logical identity for the app under test.
Cache and session identity derive from the base URL's origin by default, so
an ephemeral per-deploy origin (a PR preview) cold-starts every entry; an
explicit identity keys them by what the app *is* instead of where it happens
to be served this run. The environment always joins the derived identity —
an identity never bleeds entries across environments. It MUST be a non-empty
string, and it MUST NOT be shared across genuinely different apps: recorded
traces would replay across them.

A fuller config:

```ts
import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  specVersion: '0.1',
  app: {
    url: 'http://localhost:3000',
    command: {
      executable: 'pnpm',
      args: ['dev'],
    },
  },
  targets: [
    { name: 'web', platform: 'web', backend: playwright({ browser: 'chromium' }) },
  ],
});
```

Explicit target names are REQUIRED, unique, nonempty, and limited to ASCII
letters, numbers, `_`, `-`, and `.`. `--target`, reports, sessions,
and artifact directories all use this stable ID.

`projectId` is the stable report project identity. It defaults to the
nearest `package.json` name. If neither exists, the runner hashes the project
root real path.

## Test globs

Glob strings use `/` separators. `*` matches zero or more non-`/` characters,
`?` matches one non-`/` character, and a complete `**` segment matches zero or
more path segments. Other characters are literal; braces, extglobs, and leading
`!` exclusions are unsupported in v0. Arrays form a union and duplicates are
removed after normalization.

Matching is case-sensitive on every OS, does not follow directory symlinks, and
does not match a path segment beginning `.` unless that segment begins `.` in
the pattern. Matched regular files are sorted as specified in 11-lifecycle.md.

## Defaults

| Field | Local | CI |
|---|---:|---:|
| `tests` | `tests/**/*.e2e.ts` | same |
| `timeout` | 120,000 ms | same |
| `launchTimeout` | 60,000 ms | same |
| `actionTimeout` | 30,000 ms | same |
| `assertionTimeout` | 5,000 ms | same |
| `cleanupTimeout` | 30,000 ms | same |
| `retries` | 0 | 1 |
| `workers` | logical CPU based | 1 |
| `artifacts` | screenshot, trace (or `{ kinds, store }`) | screenshot, trace |
| `reporters` | list | list |
| `agent.maxSteps` | 25 | 25 |
| `agent.maxModelCalls` | 25 | 25 |
| `agent.maxObservationBytes` | 1 MiB | 1 MiB |
| `agent.vision` | false | false |
| `agent.visionModel` | `agent.model` | `agent.model` |
| `cache` | read-write | read-only (read-write on the file store is forced down) |
| `cache.dir` | `.e2e/cache` | same |
| `analysis` | off | off |
| `analysis.model` | `agent.model` | `agent.model` |
| `analysis.maxFailures` | 10 | 10 |
| `analysis.vision` | false | false |
| `analysis.source` | true | true |

`CI` mode is active when `CI` exists and, case-insensitively, is not empty,
`0`, or `false`. Numeric config values MUST be safe integers. Workers must be
1 or greater; retries must be 0 through 10; timeouts must be positive. Every
`limits` key is enforced: a key exists exactly when the runner has an
enforcement site for it, so a configured limit is never a silent no-op.
Every run writes the canonical JSON report regardless of renderer selection.
`agent.maxSteps` and `agent.maxModelCalls` are 1 through 100.
`agent.maxObservationBytes` is 1 KiB through 16 MiB.
`agent.vision` is the project-wide default for the per-call `vision` option
(02-test-api.md) and MUST be `true`, `false`, `"fallback"`, or `"only"`. Any mode
that can send pixels requires a model that accepts image input.

`actionTimeout` bounds every backend operation, including each observation and
action inside an agent step (16-executors.md): the step deadline caps the
whole step, `actionTimeout` caps each call within it.

`cache` is `'off'`, `'read-only'`, `'read-write'`, or an options object
`{ mode, store, dir }` (10-determinism.md). A string is shorthand for
`{ mode }`. The cache is opt-out: an unset key or mode means `read-write`,
and `--no-cache` (06-cli.md) overrides whatever the config says. `store` is a
custom `TraceCacheStore` replacing the default file store; like agents and
model instances, it never crosses a process boundary. In CI, `read-write` on
the default file store is forced to `read-only`; a custom `store` is exempt,
because it is not a committed file cache and states its own trust through its
`writable` flag (10-determinism.md).

## Targets and capabilities

A target (RFC0002) is `{ name, platform, backend? }`. The runner itself
resolves, launches, and downloads nothing: whatever the platform, the surface
is the `backend` value, a `defineBackend(...)` handle from `@e2edev/e2e/backend`. The
web backend is `playwright()` from `@e2edev/playwright`; a device or desktop
backend plugs into the same seam. There is no top-level `browser` key and no
`driver` or `browser` target key; browser choice and viewport are options of
the playwright backend.

A backend's declared capabilities (observation, actions, location, state,
artifacts, contributed fixtures) grade what the target serves. A test that
uses a fixture the backend does not support fails loud with
`UNSUPPORTED_CAPABILITY` — at selection when statically known, at first use
otherwise. A target with no backend at all serves only the agent fixture, with
every action opaque to the harness, and `app.url` is optional for it.

Before collection, the runner reads each backend's capability set, artifact
capabilities, and state capability. Configured artifacts unsupported by a
backend fail before collection. After collection/selection, any selected setup
or session consumer on a backend without state capability fails before launch.
Capability names are distinct from platform names.

## App process

`app.command` is structured and never interpreted by a shell. `executable` is
resolved with the process PATH; arguments are passed verbatim. `cwd` defaults
to project root. The child inherits only `PATH`, `HOME`, `TMPDIR`, `TMP`,
`TEMP`, `SystemRoot`, and `COMSPEC` when present. `env` explicitly adds or
replaces app variables. Model credentials, `E2E_USER_*`, CI tokens, and other
runner secrets are never inherited implicitly.

The runner starts the command as a process group, waits for `readyUrl` or
`app.url`, and fails with `APP_UNREACHABLE` after `startupTimeout`, default 60
seconds. A successful HTTP status is 200 through 499. On every exit path the
runner sends the platform's graceful termination signal to the whole process
group, waits `shutdownTimeout`, default 10 seconds, then force-terminates it.
The runner never terminates a process it did not start.

## Origins and environment

`allowedOrigins` defaults to the exact origin of the effective base URL. Agent navigation,
deep links, frame interaction, and secret fills outside this list are denied.
`file:`, `data:`, `javascript:`, link-local metadata addresses, and malformed
URLs are always denied in v0.

HTTP is allowed only for loopback hosts. Every non-loopback app origin and model
endpoint MUST use HTTPS. The runner resolves and validates destination IPs at
connection and redirect time to prevent DNS rebinding into loopback, private,
link-local, or metadata ranges unless that exact private origin is explicitly
allowed for the app.

`environment` labels the target in the report and joins the cache and session
identity digest; it never gates a run. When omitted, it defaults to `test` for
loopback, `.localhost`, and `.test` hosts and to `production` for every other
host. Security rules apply to every environment alike.

## The agent value

`agent` accepts either the options block or the agent itself: any value
implementing `StepExecutor` (16-executors.md), such as the package's
`createAgent(...)`. An executor is recognized structurally (`name` plus
`runStep`), so the two shapes cannot collide. With an agent value the options
keep their defaults and the model still resolves from `E2E_MODEL`, so the
judgment methods keep working beside a custom agent. There is no `executor` key;
the config digest records an agent value by its `name` and `version` only.

## Model configuration

There is no implicit or mutable default model. The first agent model call of a
run requires one of (a run whose steps all go to a custom agent value may
configure no model at all):

- `agent.model: 'provider/model-id'`;
- `agent.model: { provider, id, endpoint?, apiKeyEnv? }`;
- `agent.model: <model instance>` — a live language-model object from any
  AI SDK provider package (structural detection: `specificationVersion`,
  `provider`, `modelId`, `doGenerate`);
- environment `E2E_MODEL=provider/model-id`.

The first `/` separates provider from model ID in a string reference.
`E2E_MODEL_API_KEY` is the default provider credential variable; `apiKeyEnv`
may name another variable. The credential value never enters config digests,
logs, reports, or child-process arguments. Local adapters without credentials
MAY omit it.

`agent.visionModel` pins the model used by calls with `vision`
(02-test-api.md), accepting the same three forms and overridden by
`E2E_VISION_MODEL`. It is optional: unset, vision calls use `agent.model`. It
exists because visual grounding is a materially higher bar than accepting an
image, so the tier that needs it is pinnable without changing the model every
other call uses. An invocation that is sending pixels uses that model for the
rest of its lifetime, including rounds whose pixel evidence was withheld, so a
polling method never switches models between rounds. Both models are disclosed before first agent use (14-security.md), and
each step records the model it actually used (13-reporting.md).

A model instance owns its own transport and credentials; the runner passes it
to its adapter as-is. Live instances never cross a process boundary: workers
re-resolve the config module and construct their own. The config digest
replaces an instance with its stable identity (provider, model ID,
specification version), so digests stay deterministic across processes.

Nonlocal model endpoints require HTTPS. Provider transport authorization is
sent only to the configured provider; the prohibition on authorization data in
model input concerns captured application data, not the provider's own request
credential.

String references resolve through the runner's documented default routing
(this runner routes them through the AI Gateway); unknown providers are
`MODEL_UNAVAILABLE`. A v0 runner MUST ship at least one adapter and report its
exact version, but specification 0.1 does not require a particular commercial
provider. This affects config portability, not test-source portability.
Adapters consume the closed judgment and tool message families of
`agent-protocol-1`, honor cancellation/usage reporting, and cannot expand
policy.

The report records provider, model ID, resolved endpoint (`provider-default`
when a caller-supplied instance owns the transport), and adapter/policy
versions. It never records provider credentials. Model input disclosure and
offline behavior are specified in 14-security.md.

## Post-failure analysis

`analysis` enables one bounded model call per failed test-target pair after
its last attempt, classifying the failure (`app-bug`, `test-bug`,
`environment`, `flaky`, `unknown`) with a confidence, a summary, the evidence
each conclusion rests on, and an optional suggested fix. It is off unless the
key is present or `--analyze` (06-cli.md) is passed. Analysis is read-only and
post-hoc: it MUST NOT change a status, consume a test's model-call budget,
delay a retry, or fail the run. An analysis that cannot be produced is
recorded as unavailable with a closed reason (`no-model`, `limit-reached`,
`failed`, `timed-out`, `interrupted`), never silently omitted.

Only test-category failures and timeouts of ordinary pairs are analyzed;
configuration, infrastructure, and internal errors are not the application's
doing, and interrupted attempts carry no evidence. `maxFailures` (1 through
100) bounds the model calls per run. `model` accepts the same three forms as
`agent.model`, is overridden by `E2E_ANALYSIS_MODEL`, and falls back to
`agent.model`. `analyzer` replaces the built-in analyzer with a host-supplied
`FailureAnalyzer` that receives the same evidence and brings its own model; a
custom verdict is held to the same closed grammar. Like every live value, an
analyzer never crosses a process boundary.

The evidence an analyzer receives is what the runner captured the moment the
failure landed, with the session still open: the error and step timeline, the
redacted semantic tree as a `log` artifact, the masked screenshot when
`screenshot` is among the configured artifact kinds, the redacted location,
earlier attempts, and — with `source` — the failing test line with its
neighbors. Every text field is redacted before it leaves the attempt
(14-security.md); the screenshot becomes model input only with `vision` and
only when no secret was filled during the attempt. The verdict is redacted
again on the way out. Model output is untrusted prose: it reaches the report
and the event stream as data, never as a status or an instruction.

## Resource limits

Resolved limits are immutable for a run and per-call options may only lower
them. Defaults and hard maxima:

| Limit | Default | Hard maximum |
|---|---:|---:|
| discovered test-target results | 100,000 | 1,000,000 |
| terminal field bytes | 8 KiB | 64 KiB |
| agent context bytes | 16 KiB | 64 KiB |
| ledger bytes | 8 KiB | 64 KiB |
| observation bytes | 1 MiB | 16 MiB |
| artifact bytes each | 100 MiB | 1 GiB |
| total artifact bytes | 1 GiB | 10 GiB |
| download bytes each | 100 MiB | 1 GiB |
| downloads per attempt | 10 | 100 |
| report bytes | 50 MiB | 100 MiB |
| events per step | 1,000 | 10,000 |
| model tokens per call | 64,000 | 1,000,000 |
| model calls per step | 25 | 100 |
| action steps per agent call | 25 | 100 |
| estimated run cost | unset | project configured |

Documents are rejected before parsing when their byte limit is exceeded.
Readers cap JSON nesting at 100 levels and strings at 1 MiB unless a stricter
field limit applies. Reports record resolved limits and observed usage.
Collection fails before result expansion when the discovered test-target count
would exceed its limit. That bounded configuration-error report contains no
partial result inventory and zero summary counts; the run error records the
limit and observed lower bound.

## Credentials

Credential config contains executable-project secrets and is trusted input.
Environment resolution takes precedence as described in 04-resources.md.
`allowedOrigins` narrows a credential relative to the app-level policy and
cannot broaden it.

A static `password` MUST be a non-empty string; an empty one, including an
empty environment override, is a configuration error. A `password` MAY be a
provider function instead of a string: it is called on
every authorized fill and resolves the plaintext at fill time — a vault
lookup, a freshly computed one-time code. The resolved value goes straight to
the trusted driver, joins runner-side redaction the moment it exists, and is
never logged, cached, or sent to a model. An environment override wins over a
provider. Like executors and custom stores, a provider never crosses a
process boundary: workers re-resolve the config module.

## Environment variables

| Variable | Meaning |
|---|---|
| `APP_URL` | URL for the implicit web target |
| `E2E_MODEL` | exact `provider/model-id` |
| `E2E_MODEL_API_KEY` | default model-provider credential |
| `E2E_USER_<NAME>_USERNAME` | named credential username |
| `E2E_USER_<NAME>_PASSWORD` | named credential password |
| `CI` | enables deterministic CI defaults |
