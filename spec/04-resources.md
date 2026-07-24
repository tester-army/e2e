# 04 - Resources and Credentials

v0 ships one resource primitive: named credentials. Future resources use the
same ownership rules but are not part of `sdk-0.1`.

## Credentials

```ts
import { credentials } from 'e2e';

const admin = credentials.user('admin');
admin.username; // readable
admin.password; // opaque password-purpose Secret, not a string
```

`Credential` and `Secret` are nominal runtime handles. User-created objects do
not satisfy them. The handle cannot be converted to a string, serialized,
cloned, logged, or compared to its value. The trusted runner retains the
underlying value outside the test module's object graph.

Accepted secret sinks are closed:

- `agent.login(credential)`;
- `agent.type(target, secret)`;
- `locator.fill(secret)`.

`agent.act` parameters MAY contain a `Secret`; the model receives a placeholder
containing its non-sensitive name, while the runner authorizes and performs the
eventual fill. `Credential` itself is accepted only by `agent.login`.

This is not a sandbox from trusted project code. Config files, test modules,
model adapters, and in-process drivers are executable code and can read process
environment variables or deliberately inspect the app through `web.evaluate`.
The guarantee protects against disclosure to models, caches, ledgers, reports,
logs, and persisted artifacts, not against trusted test code. The complete
trust boundary is defined in [14-security.md](./14-security.md).

## Resolution

For `credentials.user('admin')`, the runner normalizes the name to uppercase
ASCII with non-alphanumeric characters replaced by `_`, then resolves:

1. `E2E_USER_ADMIN_USERNAME` and `E2E_USER_ADMIN_PASSWORD`;
2. the `credentials.admin` config entry.

Both username and password MUST be nonempty strings. A partial pair is a
configuration error. Config keys are normalized with the same algorithm;
multiple keys that normalize to one name are configuration errors. Environment
values replace username/password material as one pair while config
`allowedOrigins` remains policy. Resolution occurs on first handle acquisition;
missing material rejects with `AUTH_CREDENTIAL_UNAVAILABLE` before a model
request.

Each credential is scoped to `allowedOrigins` from its config entry, or the
app-level allowed origins when omitted. A secret fill outside that scope is
`POLICY_DENIED`.

## Ownership

Named credentials have run-scoped identity. Calling `credentials.user` with
the same normalized name in one run returns handles for the same protected
record.

Future dynamic resources default to attempt scope. A resource created in a
suite hook belongs to that suite instance. Creating one outside an active test
or hook is an error. Every acquisition registers an idempotent finalizer and
every retry gets fresh attempt-scoped resources. Labels aid reports but never
define identity.

## Extensions

Email, webhook, file, and phone resources are post-v0 extension profiles. They
MUST be imported from their extension package rather than adding core fixtures.
An extension defines its own versioned config namespace, lifecycle, local
backend, wire-safe report events, and conformance suite. Managed backends do not
change test-file syntax.
