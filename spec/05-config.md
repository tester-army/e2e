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

No file is needed for one web target:

```bash
APP_URL=http://localhost:3000 npx --no-install e2e run
```

This creates target `web`, platform `web`, browser `chromium`, and driver
`playwright`.

The effective base URL is `app.url`, then `APP_URL`; one is REQUIRED. There is
no target-level URL override in `web-0.1`. `readyUrl` defaults to the effective
base URL. The runner passes the fully resolved app/security/query context to
every driver launch.

The base URL uses WHATWG URL parsing/serialization and MUST NOT contain
userinfo, query, or fragment. Host uses IDNA ASCII form and default ports are
removed. Its pathname is normalized for dot segments and retained as the app
base path.

An explicit config:

```ts
import { defineConfig } from 'e2e';

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
    { name: 'web', platform: 'web', browser: 'chromium' },
  ],
});
```

Explicit target names are REQUIRED, unique, nonempty, and limited to ASCII
letters, numbers, `_`, `-`, and `.`. `--target`, reports, sessions, caches,
and artifact directories all use this stable ID.

`projectId` is the stable cache/report project identity. It defaults to the
nearest `package.json` name. If neither exists, the runner hashes the project
root real path and marks caches nonportable. Projects committing caches SHOULD
set an ASCII reverse-DNS or scoped-package-style `projectId` explicitly.

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
| `artifacts` | screenshot, trace | screenshot, trace |
| `reporters` | list, HTML | list, HTML |
| `agent.cache` | read-write | read-only |
| `agent.maxSteps` | 25 | 25 |
| `agent.maxModelCalls` | 25 | 25 |
| `agent.maxObservationBytes` | 1 MiB | 1 MiB |
| `agent.vision` | false | false |
| `agent.visionModel` | `agent.model` | `agent.model` |

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

## Targets and capabilities

v0 accepts web targets only. A target that requests a profile the runner does
not implement is a configuration error; it is never silently ignored. Future
mobile target declarations may compile against the reserved SDK surface but do
not satisfy `web-0.1`.

Before collection, the runner reads each driver's static platform, fixture,
artifact, and state capabilities. Configured artifacts unsupported by a driver
fail before collection. After collection/selection, any selected setup or
session consumer on a driver without state capability fails before launch.
Capability names are distinct from platform names.

`browser` config applies only to the implicit web target. An explicit target's
field wins. Defining both top-level `browser` and explicit `targets` is an error
to avoid an ignored setting.

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

When `environment` is omitted, it defaults to `test` only for loopback,
`.localhost`, and `.test` hosts. Other hosts require an explicit `test`,
`staging`, or `production` value. A production target is rejected unless
`allowProduction: true`; this opt-in is recorded in the report. Security rules
remain active after opt-in.

## Model configuration

There is no implicit or mutable default model. The first agent model call of a
run requires one of (a run whose steps all go to a custom `agent.executor` may
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
polling method never switches models between rounds. A `"fallback"` invocation
that escalates therefore changes model once, at the escalation, and the step
records that it escalated (13-reporting.md) so its reported provenance is not
read as covering the tree-only calls that preceded it. Both models are disclosed before first agent use (14-security.md), and
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
Adapters consume the closed locate, judgment, and tool message families of
`agent-protocol-1`, honor cancellation/usage reporting, and cannot expand
policy.

The report records provider, model ID, resolved endpoint (`provider-default`
when a caller-supplied instance owns the transport), and adapter/policy
versions. It never records provider credentials. Model input disclosure and
offline behavior are specified in 14-security.md.

## Agent cache mode

`off` neither reads nor writes. `read-only` validates and replays existing
entries but never modifies them. `read-write` performs atomic local updates.
`--no-agent-cache` forces `off`. CI defaults to read-only so untrusted changes
cannot create durable trusted guidance.

## Resource limits

Resolved limits are immutable for a run and per-call options may only lower
them. Defaults and hard maxima:

| Limit | Default | Hard maximum |
|---|---:|---:|
| discovered test-target results | 100,000 | 1,000,000 |
| cache entry bytes | 256 KiB | 1 MiB |
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

## Environment variables

| Variable | Meaning |
|---|---|
| `APP_URL` | URL for the implicit web target |
| `E2E_MODEL` | exact `provider/model-id` |
| `E2E_MODEL_API_KEY` | default model-provider credential |
| `E2E_USER_<NAME>_USERNAME` | named credential username |
| `E2E_USER_<NAME>_PASSWORD` | named credential password |
| `CI` | enables deterministic CI defaults |
