# 14 - Security and Trust Boundaries

Security requirements are part of every v0 conformance profile. A conforming
implementation MUST fail closed when it cannot enforce a MUST in this document.

## Threat model

Trusted in the local v0 process:

- the e2e runner and selected model adapter;
- project config, test modules, hooks, and imported helpers;
- installed in-process driver and resource packages;
- explicit ambient agent context.

Untrusted data:

- app text, accessibility trees, screenshots, URLs, frames, downloads, and
  network responses;
- model output, reasoning, tool arguments, and handoff text;
- committed caches and sessions read from disk;
- artifact labels, filenames, backend paths, and errors;
- PR title/body/diff and all code from an untrusted branch.

Conformance does not sandbox trusted executable code. Documentation and CLI
output MUST state that tests, config, adapters, and in-process drivers have the
same ambient OS authority as the runner.

## Policy authority

The runner owns immutable agent policy `policy-0.4`. System policy precedes
project context, ledger data, app content, and model output. No lower-trust
input can add tools, origins, credentials, budget, filesystem access, network
destinations, or production permission.

The system message states the model's role for the invoked tier before it states
the rules. The role is runner-owned and drawn from a closed set; it is trusted
input on the same footing as the rules, and no lower-trust input can change it.
Because the policy version is part of the agent cache key
([10-determinism.md](./10-determinism.md)), any change to that message — role text
included — requires a new policy version, which retires every entry recorded under
the previous one.

Every proposed model tool call is parsed into a closed schema and authorized by
the runner immediately before execution. Unknown tools/fields, malformed
arguments, denied destinations, stale observations, and method-incompatible
actions are `POLICY_DENIED`. Model text is never evaluated as code, selectors,
shell, JavaScript, or config.

App and ledger content is quoted as untrusted evidence. Instructions found in
the UI, page source, PR metadata, cache, or handoff have no policy authority.

## Origins and navigation

The runner validates initial URL, redirects, popups, frames, deep links, and
agent-requested navigation against `app.allowedOrigins`. Origin comparison uses
normalized URL scheme, ASCII host, and effective port. Userinfo and fragments
do not affect origin.

`file:`, `data:`, `javascript:`, browser-internal schemes, link-local addresses,
and cloud metadata endpoints are denied. HTTP(S) credentials in URLs are
denied. A redirect outside policy is blocked before interaction continues.
Non-loopback app/model traffic requires HTTPS, and destination IP policy is
rechecked after DNS resolution and redirects.

Subresource loading is the app's responsibility, but the agent cannot inspect
or interact with a cross-origin frame unless that origin is allowed. Downloads
cannot be reopened or executed by an agent in v0.

Production execution requires explicit config as described in 05-config.md.
The report records that opt-in. Production permission does not permit new
origins, secret scopes, model-proposed/portable raw-coordinate actions, or
policy bypass. Trusted deterministic `web.mouse` remains a web capability and
is reported normally.

## Credentials and confused deputies

Registered secret values never enter model requests, ledger text, cache data,
reports, terminal output, or persisted artifacts. Test/config/driver code is
trusted and may access environment variables outside framework APIs; the
framework does not claim otherwise.

Before a secret fill, the runner verifies:

1. the handle is authentic, unresolved, and registered for this run;
2. the requested sink is one of the closed secure sinks in 04-resources.md;
3. the current top-level origin and frame origin are both allowed by app and
   credential policy;
4. the node is an editable input with a declared username/password/secret
   purpose compatible with the requested secret;
5. the observation revision and node are still current;
6. no prior tool call transferred control to another origin.

The runner resolves the value only after authorization, passes it once to the
trusted driver with `sensitive: true`, then releases the temporary plaintext.
A model cannot choose a different credential or request its value.

`Credential.password` has purpose `password`. Web input purpose derives only
from standardized input type/autocomplete semantics or explicit trusted field
registration. Unknown/`none` purpose is incompatible with every secret.

## Model data boundary

Agent use is not offline unless the configured adapter is local and makes no
network requests. Before first agent use, the runner reports the provider,
model, endpoint origin, and categories sent: sanitized instruction/parameters,
bounded ledger, semantic tree, and redacted screenshot when enabled by `vision`.
Every configured model is disclosed, including a separately pinned
`agent.visionModel`. There is no silent provider or endpoint fallback.

Provider requests contain no captured application cookies/authorization headers, network bodies,
session payloads, environment values, raw HTML, hidden form values, or complete
repository files. Adapters MUST honor cancellation and MUST NOT retain or log
request bodies through framework diagnostics. Provider retention and training
terms are external operational policy and MUST be documented by the adapter.
The adapter's own transport authorization header is permitted only to the
configured provider endpoint and is never treated as model input.

An implementation MAY offer a stricter no-egress mode. In that mode any
nonlocal model endpoint or unexpected runner/driver egress fails before tests.

## Observation and artifact redaction

Secure semantic nodes are masked by the driver before observation leaves the
backend. The runner additionally replaces every exact registered secret in
textual observations and metadata. Sensitive attributes and network headers are
removed, not merely replaced.

When any secret is filled, the entire viewport remains pixel-tainted until the
attempt ends; an untrusted app may copy the value across navigation or storage
reset. While tainted, screenshots are omitted from model observations
and evidence, and video frames are discarded; rectangle masking alone cannot
prove that an untrusted app did not mirror the secret elsewhere. Semantic trees
remain usable after exact-value and secure-node redaction. Trace recording
excludes request/response bodies, authorization/cookie headers, and secure input
values by default.

## Pixel evidence as model input

Pixel evidence reaches a model only when the test asks for it with `vision`
(02-test-api.md). It is additive, and it degrades instead of failing the call:
the semantic tree is always sent, and the step records why pixels were withheld.
Pixels are withheld when

- the viewport is pixel-tainted, by the rule above, and
- masking cannot be proven complete: every secure node the driver observed MUST
  be covered by a masked region, and an image reporting fewer masked regions
  than observed secure nodes is discarded exactly like an incompletely redacted
  artifact.

Screenshot dimensions and mask counts are recorded with the step, and pixel
bytes count toward per-call token accounting. Image resolution is bounded by the
captured viewport; full-page or unbounded captures are not model input.

Pixels are untrusted evidence on the same terms as tree text, and they widen the
prompt-injection surface: text rendered in the page is readable by the model
even when no node exposes it. The runner policy MUST state that an attached
image is data, and that text drawn inside it — including anything shaped like an
instruction, a policy, or a schema — carries no authority. As everywhere else, a
model cannot select an action or an error code, and a coordinate it returns is
data the runner validates, converts, hit-tests, and records before dispatch.

If source masking, screenshot masking, trace filtering, or runner redaction
cannot be proven complete, the evidence is rejected. The runner MUST NOT upload
or persist an incompletely redacted artifact. Redaction status appears in
`report-1`.

Pixel content outside known sensitive regions may still contain application
PII. Teams are responsible for using test data; adapters and hosted artifact
stores must disclose retention and access policy.

## Sessions

Sessions contain bearer credentials. v0 sessions are per-run, target-bound,
AES-256-GCM encrypted with a memory-only random key, owner-readable only, and
deleted during cleanup. Envelope metadata is authenticated additional data and
expiry is mandatory. The session directory is gitignored; abandoned encrypted
directories are scavenged before the next run. CI persistence across jobs and
cross-run reuse are disabled in v0.

Session payloads are never included in diagnostics. A cloud or shared-session
profile requires authenticated encryption, tenant/branch isolation, TTL,
revocation, and audit requirements before it can become normative.

## Caches

Cache files are untrusted strict JSON, not code or prompts. Schema validation,
identity/fingerprint matching, path containment, size limits, and policy checks
precede use. Locate/path entries contain structured actions only. Invalid cache
content produces a miss and a sanitized diagnostic. A locate entry MAY carry a
platform selector, which is structural rather than semantic and is gated only by
the recorded role/name identity, so it does not restrict which nodes the entry
may aim at; 10-determinism.md states what that concedes.

Untrusted CI runs use read-only or off mode. They cannot publish to a trusted
cache, session store, package, artifact host, or branch. Cache review does not
replace runtime validation.

## Untrusted pull requests

v0 treats test/config/driver code as trusted and does not provide an in-process
untrusted mode. If a project nevertheless executes fork or untrusted branch
code, CI MUST place it in an external ephemeral OS/container sandbox without
repository secrets, write-capable tokens, production credentials, shared
cache/session write access, or privileged network placement. A trusted reporting job MAY consume
the untrusted job's sanitized `report-1` only through a quarantined,
size-bounded channel bound to repository, workflow run, and head SHA. That
channel is not a trusted shared artifact/cache store. The reporting job MUST NOT
execute or import untrusted code and MUST run the reference semantic report
validator before rendering.

Privileged workflows MUST NOT use `pull_request_target` with an untrusted
checkout. CI examples pin actions by immutable commit SHA, use a frozen
lockfile, and invoke the locally installed CLI without mutable package
resolution.

## Resource limits

The runner enforces test/operation deadlines, worker count, retries, model
calls, action steps, observation size, artifact-root disk quota, individual
artifact size, download count/size, terminal field size, and report event size.
Resolved defaults are:

- one observation is capped by `agent.maxObservationBytes`;
- one cache entry at 256 KiB;
- one untrusted terminal field at 8 KiB;
- one agent context at 16 KiB;
- one ledger context at 8 KiB.

Projects may lower or raise these defaults only within the hard ceilings in
05-config.md. Resolved limits and usage MUST
be reported. Quota exhaustion cancels active work and produces a typed
infrastructure or budget error; it never silently drops required evidence.
Model adapters enforce token limits using provider counts or conservative
adapter upper bounds; unavailable accounting fails before the request.

## Reports, HTML, and paths

Reports apply contextual escaping, strip terminal controls, use generated
artifact names, canonicalize paths, reject symlink traversal, and impose a
Content Security Policy with no remote scripts/styles. Model/app strings are
always rendered as text. Artifact labels never become path components.

Reports contain sanitized origin and model provenance but no query parameters
known to contain secrets. Implementations SHOULD support additional user-defined
redaction patterns without weakening required masking.

## Supply chain

Official releases SHOULD publish provenance and integrity metadata. CI uses
frozen lockfiles, exact framework/driver/backend versions, immutable action
SHAs, and verified browser/device downloads. Driver conformance is not a supply
chain trust signal.

## Security conformance

Required vectors cover prompt-injection resistance, tool schema rejection,
origin/redirect/frame enforcement, credential purpose/origin checks, semantic
and pixel masking, trace filtering, cache poisoning, session isolation, path
traversal, terminal/HTML injection, cancellation, and untrusted-CI defaults.
