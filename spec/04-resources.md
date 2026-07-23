# 04 — Resources

Resources are managed test-world primitives: inboxes, credentials, webhooks,
phone numbers. They resolve to a local adapter or a managed Cloud backend
depending on config — the test code is identical.

All resource factories are importable from the root:

```ts
import { email, credentials, webhook, phone } from 'e2e';
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
  /** Password is write-only by default; reveal() requires config opt-in. */
  reveal(): Promise<{ username: string; password: string }>;
};
```

### Resolution order

1. `E2E_USER_<NAME>_USERNAME` / `E2E_USER_<NAME>_PASSWORD` env vars
2. `credentials` block in `e2e.config.ts` (values may reference env)
3. Encrypted local store (`npx e2e credentials set admin`)
4. TesterArmy Cloud vault (when `runner: 'cloud'`)

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

## `webhook` — backend event capture

Assert that your app emitted an event to the outside world, or feed events in.

```ts
const callback = webhook.capture('candidate-created');
```

- The capture exposes a URL your app (or emulated service) can be pointed at.
- In local mode this is a localhost endpoint; in Cloud it is a public URL.

```ts
type WebhookCapture = {
  url: string;

  /** Wait for the next matching delivery. */
  waitFor(match?: DeepPartial<unknown>, options?: { timeout?: number }): Promise<WebhookDelivery>;

  /** All deliveries so far. */
  deliveries(): Promise<WebhookDelivery[]>;
};

type WebhookDelivery = {
  headers: Record<string, string>;
  body: unknown;
  receivedAt: Date;
};
```

```ts
const hook = webhook.capture('candidate-created');

await agent.act('create a candidate named Ada');

const delivery = await hook.waitFor({ type: 'candidate.created' });
await expect(hook).toHaveReceived({ payload: { name: 'Ada' } });
```

## `files` — file fixtures

File handles for upload flows. The agent can only use files explicitly
passed to a step — never files it picks itself (see 10-determinism.md):

```ts
import { test, files } from 'e2e';

const resume = files.from('fixtures/resume.pdf');

await agent.act('apply for the job and attach the resume', {
  files: [resume],
});
```

```ts
type FileRef = {
  readonly name: string;
  readonly mimeType: string;
  /** Optional description the agent uses when deciding how/where to use the file. */
  readonly context?: string;
};

files.from(path: string, options?: { name?: string; mimeType?: string; context?: string }): FileRef;

/** Agent-generated context for all registered files. Optional; cached. */
files.index(): Promise<void>;
```

`context` improves agent file handling ("signed NDA, PDF, 2 pages" beats a
bare filename). Set it manually, or call `files.index()` once to have the
agent inspect registered files and generate context; results are cached
alongside the agent cache.

Delivery supports direct `<input type=file>` writes and staged mode for
native/File System Access pickers. In Cloud, files can also resolve from
managed project fixtures.

## `phone` — SMS/voice numbers (Cloud-first, post-v0)

Reserved API shape; not shipped in v0 OSS.

```ts
const number = phone.number('candidate');

number.address;                       // E.164 string
await number.sms({ timeout: 60_000 }); // next SMS
await number.code();                   // extract OTP from next SMS
```

## Lifecycle & isolation

- Resources are scoped to the **test** by default; a resource created in
  `beforeAll` is scoped to the file.
- Every retry gets fresh resources.
- Labels exist for readability and artifact naming, not identity.
