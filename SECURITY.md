# Security

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
`command`, `services`, or `cache.store` you configure. A trace cache committed
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
its own observation (an unresolved handle, a secure sink, an allowed origin,
an editable node with a compatible purpose, no control transfer since); the
model never sees or picks the value. Once a secret is filled, the viewport
stays pixel-tainted for the rest of the attempt, and the attempt's Playwright
trace is rewritten before it is registered or stored: every credential value,
in every encoding a trace spells it, becomes `<secret:name>`, and a trace that
cannot be rewritten is deleted. Sessions are per-run, target-bound, encrypted
with a memory-only key, and deleted at cleanup.

## Navigation policy

Every navigation the runner or the agent requests is checked against the
target's `allowedOrigins`. `file:`, `data:`, `javascript:`, link-local, and
cloud-metadata destinations are denied. Child frames outside the allowed
origins are dropped from observations.

Two gaps are open and on the roadmap. The top-level document is not
re-checked after a server redirect lands somewhere else, and popups the page
opens are not checked at all. Until both close, treat a target whose app can
redirect or open windows off-origin as one the agent may follow there.

## Telemetry and outbound traffic

The CLI sends anonymous usage telemetry, on by default. One `e2e_cli_session`
event per command carries the command name, the names of the flags given, the
e2e, Node, and OS versions, the CPU count and memory class, and whether the
shell is a container, a CI vendor, or a coding agent. One `e2e_run_completed`
event per run carries the report's numbers: status, exit code, duration, test
and step counts, engine names and versions, platforms, cache replay counts,
model provider and public model id, token totals, and the runner's error codes.
Events are attributed to a random per-machine id and a hashed project id (the
SHA-256 of the repository's root commit); in CI the vendor's name stands in for
the machine, and without git, or with a shallow checkout, there is no project
id. Test titles, file paths,
URLs, instructions, observations, messages, stack traces, environment
variables, and credentials are never sent. Engine names, platforms, and model
ids are sent as your config declares them when they are plain tokens and as
`other` otherwise; an error code that is not an upper-case token is `OTHER`.
Every property
is listed at [e2e-docs.vercel.app/telemetry](https://e2e-docs.vercel.app/telemetry),
and `E2E_TELEMETRY_DEBUG=1` prints each event instead of sending it.

Opt out with `e2e telemetry disable`, `E2E_TELEMETRY_DISABLED=1`, or
`DO_NOT_TRACK=1`. Telemetry is a CLI concern; the runner itself sends nothing.
Telemetry falls under the disclosure policy above.

There is no crash reporting and no update check. The complete list of
outbound connections a run can make:

- one telemetry request per CLI invocation to `eu.i.posthog.com`, unless
  opted out
- the model endpoint named by `E2E_MODEL` (agent steps only; deterministic
  suites make no model calls, and cached steps replay without one)
- `readyUrl` probes against the app the runner starts
- Playwright browser downloads, once, when Chromium is missing
- the app under test, and whatever that app itself loads

`e2e run --ai-trace` writes every model call to a local file. Nothing uploads
it.

## Known non-goals

`command.log` and service logs are captured as the process writes them; the
runner does not redact them. Keep secrets out of your app's stdout.
