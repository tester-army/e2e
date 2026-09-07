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
platform, so every target names the backend that serves it. The app under
test is the backend's to declare, never a config key: a browser backend is
told where the app is served, a device backend which app it pins. The
smallest useful config is one web target on the playwright backend from
`@e2edev/playwright`:

```ts
import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  targets: [{ name: 'web', platform: 'web', backend: playwright({ url: 'http://localhost:3000' }) }],
});
```

There is no top-level `app` key and no `APP_URL` fallback in the runner: a
config that wants an environment override reads it itself
(`url: process.env.APP_URL ?? 'http://localhost:3000'`, which is what `init`
scaffolds). A URL is REQUIRED once a test calls `app.open()` or navigates
relatively and optional otherwise; without one those calls fail with
`APP_URL_REQUIRED`. The runner passes each target's resolved URL and origin
policy back to its backend's `init`.

The base URL uses WHATWG URL parsing/serialization and MUST NOT contain
userinfo, query, or fragment. A base URL without a scheme gets `https://`, or
`http://` when its host is loopback, so `tester.army` and `localhost:3000` are
both accepted as written. Host uses IDNA ASCII form and default ports are
removed. Its pathname is normalized for dot segments and retained as the app
base path.

A fuller config, with the runner starting the app itself:

```ts
import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  specVersion: '0.1',
  targets: [
    {
      name: 'web',
      platform: 'web',
      backend: playwright({
        browser: 'chromium',
        url: 'http://localhost:3000',
        command: { executable: 'pnpm', args: ['dev'] },
      }),
    },
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
| `cache` | read-write | read-only when `mode` is unset; an explicit mode is kept |
| `cache.dir` | `.e2e/cache` | same |

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
model instances, it never crosses a process boundary. In CI an unset mode on
the default file store is demoted to `read-only`; an explicit `read-write`
is honored, and a custom `store` is exempt because it is not a committed
file cache and states its own trust through its `writable` flag
(10-determinism.md).

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
every action opaque to the harness; it has no app URL and needs none.

Before collection, the runner reads each backend's capability set, artifact
capabilities, and state capability. Configured artifacts unsupported by a
backend fail before collection. After collection/selection, any selected setup
or session consumer on a backend without state capability fails before launch.
Capability names are distinct from platform names.

## The app under test

A backend's `app` manifest declares the app it drives beside its app hooks
(`BackendAppDeclaration` in [`api/e2e.d.ts`](./api/e2e.d.ts)): `url`,
`allowedOrigins`, `environment`, `identity`, `command`, `readyUrl`, and
`services`, every one optional. The runner resolves the declaration once per target at config
load and owns what is built on it: navigation and origin policy, cache and
session identity, the report's target record, and the app process. A target
without a backend, or whose backend declares nothing, resolves to the empty
app: no URL, no allowed origins, environment `test`, no identity. Unknown
declaration keys fail at `defineBackend`; invalid values fail at config load
naming the target.

`identity` is the stable logical identity cache and session entries key on.
It defaults to the declared URL's origin and base path, so an ephemeral
per-deploy origin (a PR preview) cold-starts every entry; an explicit identity
keys them by what the app *is* instead of where it happens to be served this
run. A backend without a URL declares its own (a bundle id, a build) or its
entries key on the target alone. The environment always joins the derived
identity — an identity never bleeds entries across environments. It MUST be a
non-empty string, and it MUST NOT be shared across genuinely different apps:
recorded traces would replay across them.

`command` is structured and never interpreted by a shell. `executable` is
resolved with the process PATH; arguments are passed verbatim. `cwd` defaults
to project root. `readyUrl`, when set, MUST be an absolute http(s) URL, else
`INVALID_CONFIG`. The child inherits only `PATH`, `HOME`, `TMPDIR`, `TMP`,
`TEMP`, `SystemRoot`, and `COMSPEC` when present. `env` explicitly adds or
replaces app variables. Model credentials, `E2E_USER_*`, CI tokens, and other
runner secrets are never inherited implicitly.

The child's stdout and stderr are discarded unless `log` names a file: the
runner then opens that path in append mode, resolved from the project root and
required to stay inside it (any other value is `INVALID_CONFIG`), creates the
missing parent directories, and hands the same descriptor to the child for both
streams. Appending keeps earlier runs and lets several commands share one file.
A log that cannot be opened fails the run with `APP_UNREACHABLE`. The file is
the process's raw output and is never redacted, so anything the app prints,
including secrets from its own `env`, persists there; it belongs in an ignored
directory such as `.e2e/logs/`, which `e2e init` adds to `.gitignore`.

The runner starts each distinct declared command as a process group before
the first test (targets declaring the same command share one process, probed
at the first declaring target's `readyUrl`),
waits for `readyUrl` or `url` (a command with neither is `APP_URL_REQUIRED`
at config load), and fails with `APP_UNREACHABLE` after `startupTimeout`,
default 60 seconds. A successful HTTP status is 200 through 499. On every exit
path the runner sends the platform's graceful termination signal to the whole
process group, waits `shutdownTimeout`, default 10 seconds, then
force-terminates it. The runner never terminates a process it did not start.

### Services

`services` declares the dependency processes the app needs before it can
boot: a database container, a cache, an auth emulator, a migration step. Each
entry is a `CommandConfig` with the same shell-free spawning, the same `cwd`
default, the same `log` capture, and the same environment rule as `command`:
a service child inherits only the allowlist above plus its own `env`. A
service's `teardown` is a `CommandConfig` too and takes its own `log`.
`services` is valid without `command`; the app may already be running or be
one of the services itself.
Services declared identically by several targets start once; distinct ones
are gathered in target order. Two targets that declare shared services in
opposite orders are `INVALID_CONFIG`, as are two different services under one
explicit `name`: an ordering the runner cannot honor, or a label that names
two processes, is refused before anything spawns.

Services start sequentially in declaration order, before any app command and
before collection. Each service MUST be ready before the next one starts.
Exactly one readiness contract is required per service, and a service with
neither or both is `INVALID_CONFIG`:

- `readyUrl`: the runner probes the URL exactly as it probes the app; a status
  of 200 through 499 is ready.
- `waitForExit: true`: the process itself is the step; it is ready when it
  exits with code 0.

Readiness is bounded by the service's `startupTimeout`, default 60 seconds. A
non-zero exit, termination by a signal, a spawn failure, or an expired budget
fails the run with `APP_UNREACHABLE`, and the message names the service by its
`name`, which defaults to the executable's base name; an explicit `name` MUST be
a non-empty string of at most 64 characters and unique among the explicitly
named services of a declaration, otherwise the config is `INVALID_CONFIG`.

Teardown runs on every exit path: success, failure, and interrupt. The runner
stops every app command first, then stops the started services in reverse
order with the same signal-then-force sequence, then runs each started
service's optional `teardown` command in reverse order and waits for it to
exit, bounded by the teardown's own `startupTimeout`, default 60 seconds. A
service that already exited under `waitForExit` has nothing to stop but still
gets its teardown. A teardown command that fails or does not exit in time is
recorded as a `cleanup`-phase run error; it never aborts the remaining
teardowns and never crashes the runner. Services never started because an
earlier one failed get no teardown.

## Origins and environment

`allowedOrigins` defaults to the exact origin of the declared URL, and to no
origin without one. Agent navigation,
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
loopback, `.localhost`, and `.test` hosts and for a surface without a URL, and
to `production` for every other host. Security rules apply to every
environment alike.

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
`allowedOrigins` narrows a credential relative to the target's app policy and
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

The runner reads a closed set. `APP_URL` is not in it: the scaffolded config
reads it itself and hands it to the backend, so a project may name any
variable, or none.
| Variable | Meaning |
|---|---|
| `E2E_MODEL` | exact `provider/model-id` |
| `E2E_MODEL_API_KEY` | default model-provider credential |
| `E2E_USER_<NAME>_USERNAME` | named credential username |
| `E2E_USER_<NAME>_PASSWORD` | named credential password |
| `CI` | enables deterministic CI defaults |
