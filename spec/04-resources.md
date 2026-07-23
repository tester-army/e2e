# 04 — Resources

Resources are managed test-world primitives. v0 ships one: **credentials**.
The model is the point: a resource is declared with a clean handle and
resolves to a local adapter or a managed Cloud backend depending on config —
the test code is identical. Email inboxes, webhook captures, files, and
phone numbers ship later as **extensions** on this exact model.

Resource factories are importable from the root:

```ts
import { credentials } from 'e2e';
```

## `credentials` — test identities

```ts
const admin = credentials.user('admin');
```

Returns an opaque `Credential` handle. Secrets are **never** readable in test
code — handles are passed to `agent.login()` or form fills.

```ts
type Credential = {
  name: string;          // 'admin'
  username: string;      // readable (email/login)
  // the password is write-only: filled host-side, never readable in test code
};
```

### Resolution order

1. `E2E_USER_<NAME>_USERNAME` / `E2E_USER_<NAME>_PASSWORD` env vars
2. `credentials` block in `e2e.config.ts` (values may reference env)
3. TesterArmy Cloud vault (when `runner: 'cloud'`)

### Usage

```ts
import { test, credentials } from 'e2e';

export default test('admin can invite teammate', async ({ app, agent }) => {
  const admin = credentials.user('admin');

  await app.open();
  await agent.login(admin);

  await agent.act('invite a teammate as viewer');

  await agent.assert('the invite was sent successfully');
});
```

## Resource extensions (post-v0)

Deliberately not in the v0 core — see [roadmap/](./roadmap/README.md) for
the reserved designs:

- **`email.inbox()`** — fresh unique address per test, `.code()`/`.link()`
  extraction, `expect(inbox).toHaveEmail(…)`; local SMTP catcher or managed
  deliverable inboxes. The first extension to land.
- **`webhook.capture()`** — backend event capture with a pointable URL.
- **`files.from()`** — upload fixtures the agent may use, host-narrowed.
- **`phone.number()`** — SMS/OTP, Cloud-first.

Extensions follow the driver philosophy: the core defines the resource
model; each extension arrives as its own module with a local backend and a
managed Cloud backend, no new syntax.

## Lifecycle & isolation

The contract every resource (current and future) obeys:

- Dynamic resources are scoped to the **test** by default; one created in
  `beforeAll` is scoped to the file. Named credentials resolve per run.
- Every retry gets fresh dynamic resources.
- Labels exist for readability and artifact naming, not identity.
