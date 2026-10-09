# Security

The user-facing version of this document is
[e2e.tester.army/docs/security](https://e2e.tester.army/docs/security). Every
rule and limit, as the code enforces it, is in
[e2e.tester.army/docs/reference/security](https://e2e.tester.army/docs/reference/security).

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/tester-army/e2e/security/advisories/new)
or by mail to security@tester.army. Do not open a public issue for anything
that lets a page, a model, or a committed file act with more authority than
this document grants it.

You get an acknowledgement within 3 business days and a fix or a written plan
within 30 days. We credit reporters in the advisory unless they ask us not to.

## Supported versions

Only the latest published `0.x` minor of each package receives fixes. A
security fix ships as a patch on that minor; older minors are not patched.
Once `1.0` is out this becomes the current major plus the previous one for
six months after the newer major's release.

## Trust model

Two kinds of input exist here, and the line between them is the whole model.

**Code-trust.** Everything you run has your OS authority, with no sandbox in
between: test files, `e2e.config.ts`, custom tools, engines, and any
`command`, `services`, or `cache.store` you configure. A replay cache committed
to the repository is code-trust as well: the runner replays recorded actions
from it without asking the model, so a bad entry is a bad test, not a
compromise of the runner. If the code came from an untrusted pull request, run
it in an external sandbox with no secrets and no write tokens. The framework
will not protect you from your own dependencies.

**Untrusted model input.** Page content is evidence, never instructions.
Text, accessibility trees, and pixels from the app under test are quoted to
the model as untrusted; the runner, not the model, decides what a tool call
may do. Every model tool call is parsed into a closed schema and authorized
right before dispatch. Unknown tools or fields, stale observation references,
and denied destinations fail with `POLICY_DENIED`. Model text is never
evaluated as code, selectors, shell, or config.

Secrets follow from that split. A `Secret` never reaches model input, digests,
logs, reports, or artifacts. A secret fill is authorized by the runner from
its own observation (an unresolved handle, a secure sink, an editable node
with a compatible purpose, no control transfer since); the
model never sees or picks the value. Once a secret is filled, the viewport
stays pixel-tainted for the rest of the attempt, and a text download (`.txt`,
`.csv`, `.json`, `.html`) is rewritten before it is registered or stored, every secret value becoming
`<secret:name>`; any other download is kept as served and marked
`incomplete`. Sessions are per-run, target-bound, encrypted
with a memory-only key, and deleted at cleanup.

## Navigation and origins

On the web a test or the agent may open any http(s) URL, and `about:blank`;
every other scheme (`file:`, `data:`, `javascript:`, `view-source:`, `blob:`)
is denied. A device link may use an app's custom scheme, so
`device.openLink` refuses a list instead: `file:`, `data:`, `javascript:`,
`view-source:`, `blob:`, and `filesystem:`. There is no origin allowlist, on navigation or on
secret fills. A click, a redirect, or a popup reaches another origin just as
a typed URL would, so a gate on typed navigation guarded nothing; and a
secret is only ever typed into a field the test itself handed to the step, a
password only into a password field, so an origin gate on the fill guarded
against a model mistake at the cost of configuring every sign-in flow that
leaves the app's domain. Treat a target whose app can send the agent
elsewhere as one the agent may follow there, with the secrets the step was
given. If a threat model ever calls for an origin allowlist again, it comes
back as an opt-in.

Two things still key on the site of the target's `url`, its registrable
domain: the browser engine's `headers` reach the site and no other host, and
child frames off the site are dropped from observations.

## Telemetry and outbound traffic

The CLI sends anonymous usage telemetry, on by default. One `e2e_cli_session`
event per command carries the command name, the names of the flags given, the
exit code and the runner error code that ended the command, the e2e, Node, and
OS versions, the CPU count and memory class, and whether the shell is a
container, a CI vendor, or a coding agent. One `e2e_init_completed` event per
`e2e init` carries how it ended and the ids of the engine and gateway chosen. One `e2e_run_completed`
event per run carries the report's numbers: status, exit code, duration, test
and step counts, attempt counts, engine names and versions, platforms, cache
replay counts, the agent's action counts by the runner's own action names,
model provider and public model id, token totals, and the runner's error codes,
each paired for an engine or provider failure with a kind from a closed list
(`timeout`, `rate-limit`, `device`, ...) that the message was matched against,
plus counts and option ids of the config features used (workers, retries,
agents, recording modes, ...) and, for `e2e explore`, why it stopped and how
many steps and findings of each kind and severity it had. One `e2e_mcp_session`
event per `e2e mcp` session that closes or fails to open (one still open when
the client kills the server is lost) carries the name and version the MCP client gives
itself, the platform and engine, how the session ended, its duration, and its
tool calls counted by the runner's own tool names with the error codes they
failed with.
Events are attributed to a random per-machine id and a hashed project id (the
SHA-256 of the repository's root commit); in CI the vendor's name stands in for
the machine, a platform that sets `E2E_TELEMETRY_FLEET` is attributed to that
name, and without git, or with a shallow checkout, there is no project id. Test titles, file paths,
URLs, instructions, observations, messages, stack traces, environment
variables, and credentials are never sent as telemetry, nor are MCP tool
arguments or results, exploration goals, or findings. Engine names, platforms, model
ids, and MCP client names are sent as declared when they are plain tokens and as
`other` otherwise; an error code that is not an upper-case token is `OTHER`.
Every property
is listed at [e2e.tester.army/docs/telemetry](https://e2e.tester.army/docs/telemetry),
and `E2E_TELEMETRY_DEBUG=1` prints each event instead of sending it. PostHog
stores no request address and, because every event carries
`$geoip_disable: true`, derives no location from it.

Opt out with `e2e telemetry disable`, `E2E_TELEMETRY_DISABLED=1`, or
`DO_NOT_TRACK=1`. Telemetry is a CLI concern; the runner itself sends nothing.
Telemetry falls under the disclosure policy above.

There is no crash reporting and no update check. The complete list of
outbound connections a run can make:

- one telemetry request per CLI invocation to `eu.i.posthog.com`, plus at
  most one per session that `e2e mcp` serves, unless opted out
- one request to `eu.i.posthog.com` per `e2e feedback` someone runs, carrying
  the report written into its flags; `E2E_TELEMETRY_DISABLED` and
  `DO_NOT_TRACK` stop it
- the model endpoint owned by the AI SDK instance in your config (agent steps
  only; deterministic suites make no model calls, and cached steps replay
  without one)
- `readyUrl` probes against the app the runner starts
- Playwright browser downloads, once, when Chromium is missing
- the app under test, and whatever that app itself loads

`e2e run --ai-trace` writes every model call to a local file. Nothing uploads
it.

## Known non-goals

`command.log` and service logs are captured as the process writes them; the
runner does not redact them. Keep secrets out of your app's stdout.
