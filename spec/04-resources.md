# 04 — Resources

Resources are managed test-world primitives. v0 ships two: **email inboxes**
and **credentials**. They resolve to a local adapter or a managed Cloud
backend depending on config — the test code is identical.

All resource factories are importable from the root:

```ts
import { email, credentials } from 'e2e';
```

## `email` — inboxes

```ts
const inbox = email.inbox('signup');
```

- `'signup'` is a **label**, not an address. Each test run gets a fresh,
  unique address per label (isolation by default).
- `inbox.address` is a real receiving email address.

### Surface

```ts
type Inbox = {
  /** Unique receiving address for this test run. */
  address: string;

  /** Wait for + extract a numeric/alphanumeric verification code. */
  code(options?: {
    from?: string | RegExp;
    subject?: string | RegExp;
    timeout?: number;       // default 60_000
  }): Promise<string>;

  /** Wait for + extract the primary action link (magic link, invite, reset). */
  link(options?: {
    from?: string | RegExp;
    subject?: string | RegExp;
    text?: string | RegExp; // match the link's anchor text
    timeout?: number;
  }): Promise<string>;

  /** Wait for a full email. */
  email(options?: {
    from?: string | RegExp;
    subject?: string | RegExp;
    timeout?: number;
  }): Promise<Email>;

  /** All emails received so far (no waiting). */
  emails(): Promise<Email[]>;
};

type Email = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  links: string[];
  receivedAt: Date;
};
```

### Canonical flow

```ts
import { test, expect, email } from 'e2e';

export default test('email signup works', async ({ app, agent }) => {
  const inbox = email.inbox('signup');

  await app.open();

  await agent.act('create an account using this email', {
    email: inbox.address,
  });

  const code = await inbox.code({ from: 'noreply@example.com' });

  await agent.act('enter the verification code', { code });

  await agent.assert('the user is signed in and sees the dashboard');
});
```

### Backends

| Mode | Backend |
|---|---|
| `resources.email: 'local'` | bundled SMTP catcher (Mailpit-style), or adapter: Mailosaur, IMAP, custom |
| `resources.email: 'managed'` | TesterArmy Cloud inboxes with real deliverable addresses |

## `credentials` — test identities

```ts
const admin = credentials.user('admin');
```

Returns an opaque `Credential` handle. Secrets are **never** readable in test
code by default — handles are passed to `agent.login()` or form fills.

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
import { test, expect, credentials } from 'e2e';

export default test('admin can invite teammate', async ({ app, agent }) => {
  const admin = credentials.user('admin');

  await app.open();
  await agent.login(admin);

  await agent.act('invite a teammate as viewer');

  await agent.assert('the invite was sent successfully');
});
```

## Post-v0 resources

`webhook.capture()` (backend event capture), `files.from()` (upload
fixtures), and `phone.number()` (SMS/OTP) are deliberately not in the v0
core — see [roadmap/](./roadmap/README.md) for the reserved designs. The
resource model above (labels, per-test isolation, local/managed backends)
is how they will ship.

## Lifecycle & isolation

- Resources are scoped to the **test** by default; a resource created in
  `beforeAll` is scoped to the file.
- Every retry gets fresh resources.
- Labels exist for readability and artifact naming, not identity.
