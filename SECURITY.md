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
stays pixel-tainted for the rest of the attempt. Sessions are per-run,
target-bound, encrypted with a memory-only key, and deleted at cleanup.

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

The framework sends nothing home. There is no usage telemetry, no crash
reporting, and no update check. The complete list of outbound connections a
run can make:

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
