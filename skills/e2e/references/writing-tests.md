# Writing tests

## A complete file

```ts
// tests/todos.e2e.ts
import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('todos', { tags: ['todos'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/todos');
  });

  test('adds and completes a todo', async ({ agent, screen, web }) => {
    await agent.act('add a todo named {title}', { params: { title: 'Write the release notes' } });
    await expect(screen.getByRole('listitem')).toHaveCount(1);
    await expect(screen.getByRole('status', { name: 'Remaining' })).toHaveText('1 remaining');

    await agent.act('mark the todo as done');
    await expect(screen.getByRole('status', { name: 'Remaining' })).toHaveText('0 remaining');
    await expect(web).toHaveURL('/todos');
  });

  test('ignores an empty submission', async ({ screen }) => {
    // An exact interaction: the empty submit is the point of the test.
    await screen.getByRole('button', { name: 'Add' }).tap();
    await expect(screen.getByRole('listitem')).toHaveCount(0);
  });
});
```

The agent does the flow; `expect` pins what must be true after each goal,
and that check is what lets the trace cache replay the step on later runs.
`screen` actions are for exact interactions and values, like the empty
submit above or a sign-in form. Files match the config `tests` glob, default
`tests/**/*.e2e.ts`. Every test starts from clean state: a fresh browser
context and no page open, so a test calls `app.open()` first (here in
`beforeEach`). On a device `app.open()` takes no path and launches the pinned
app fresh; a test that skips it starts where the previous test left the app.

## Registration

`test` is the only registration surface; everything registers while the file
is imported, so a `describe` body is synchronous (an `async` body is a
`COLLECTION_ERROR`).

```ts
test('title', async ({ app, screen }) => {});
test('title', { tags: ['smoke'], retries: 2, timeout: 60_000 }, async ({ app }) => {});
test.describe('group', { tags: ['billing'] }, () => { /* tests and hooks */ });
test.describe('checkout flow', { serial: true }, () => { /* ordered, shared app state */ });
test.beforeEach(async ({ app }) => {});     // per attempt, with test fixtures
test.afterEach(async ({ screen }) => {});   // runs after failures too, with its own cleanup budget
test.beforeAll(async ({ platform }) => {}); // per suite realm, no app fixtures
test.afterAll(async () => {});
test.skip('later', async () => {});
test.only('focus', async () => {});         // local only: CI fails with ONLY_IN_CI
test('conditional', async () => { test.skip(await onlyOneOrg(), 'nothing to switch to'); }); // skips from the body; steps so far stay in the report
test.setup('sign in', { sessions: ['admin'] }, async ({ app, screen, session }) => {}); // see Sign-in sessions
const wsTest = test.extend<{ ws: Ws }>({ ws: async ({ web }, use) => { await use(await seed()); await drop(); } });
wsTest('uses the workspace', async ({ ws }) => {}); // code after use() is teardown, runs after failures too
```

| Option | Default | Notes |
| --- | --- | --- |
| `timeout` | `config.timeout`, 120 s | Covers `beforeEach` and the body. |
| `retries` | `config.retries` | 0 to 10. On a serial group, the group's value applies. |
| `tags` | `[]` | Distinct names, none blank, with no comma and no leading or trailing whitespace (`'Login Form'` is fine); union across layers. Select with `--tag smoke`; `--tag-mode all` requires every tag. |
| `skip` | unset | `true` or a reason string. |
| `platforms` | unset | Run only on targets with these platforms, e.g. `['ios']`. |
| `requires` | `[]` | Capabilities the engine must contribute, e.g. `['web']`. Otherwise the test is skipped at selection instead of failing with `UNSUPPORTED_CAPABILITY`. |
| `session` | unset | Restore state saved by a setup test. |
| `agentContext` | unset | Extra context for `agent.*` calls in this test or group. |
| `agent` | the run's agent | Pin the test or group to a configured agent (`agents.<name>`). Innermost wins; `agent.act(..., { agent })` can name another for one call. |
| `serial` | `false` | Groups only. Members share one app state, run in order on one worker, and retry as a whole. Inside, per-member `retries`, `session`, `platforms`, `requires`, and `skip` are errors. |

Hook order follows nesting, not position: outer `beforeEach` first, inner
`afterEach` first. `beforeAll` runs again for every retry and every serial
group, because each is a fresh module realm.

## Fixtures

Fixtures are lazy; destructure them in the callback.

| Fixture | Type | Available |
| --- | --- | --- |
| `app` | `App` | Always. |
| `screen` | `Screen` | Always. |
| `agent` | `Agent` | Needs a configured model, else `MODEL_UNAVAILABLE`. See the `agent` topic. |
| `platform` | `'web' \| 'ios' \| 'android' \| string` | Always; also in `beforeAll` and `afterAll`. |
| `web` | `Web` | Browser targets. Import `test` from `@e2edev/web`. |
| `device` | `Device` | Device targets. Import `test` from `@e2edev/mobile`. |
| `session` | `SetupSession` | Only in `test.setup`. |

### app

| Method | Does |
| --- | --- |
| `open(path?)` | Opens the engine's `url`, a path relative to it, or any absolute http(s) URL. |
| `back()` | One history step back. |
| `restart()` | Recreates the context and keeps persisted state, including a restored session. |
| `clearState()` | Clears cookies and storage, then relaunches. Not inside a serial group. |
| `screenshot(label?)` | Saves a redacted screenshot as an artifact and returns its path. Fails with `POLICY_DENIED` after a secret fill. |

## Locators

`screen.getBy*` builds a lazy query; nothing resolves until an action, read,
or assertion runs. Every query also exists on a locator, scoped to its
subtree.

| Query | Matches |
| --- | --- |
| `getByRole(role, { name?, exact?, checked?, disabled?, selected?, expanded?, visible? })` | Semantic role, optionally by accessible name and state. First choice. |
| `getByLabel(text, { exact?, visible? })` | Form controls by label. |
| `getByPlaceholder(text)` | Inputs by placeholder. |
| `getByText(text, { exact?, visible? })` | Visible text. |
| `getByDisplayValue(value)` | Inputs by current value. |
| `getByTestId(id, { visible? })` | `data-testid` on the web (or `web({ testIdAttribute })`), the accessibility identifier or resource id on a device. Last resort. |

Roles: `button`, `link`, `textbox`, `searchbox`, `combobox`, `listbox`,
`option`, `checkbox`, `radio`, `radiogroup`, `switch`, `slider`, `spinbutton`,
`progressbar`, `meter`, `image`, `heading`, `tab`, `tablist`, `tabpanel`,
`menu`, `menubar`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `toolbar`,
`tooltip`, `tree`, `treeitem`, `list`, `listitem`, `table`, `grid`, `row`,
`rowgroup`, `rowheader`, `cell`, `gridcell`, `columnheader`, `separator`,
`group`, `article`, `figure`, `form`, `status`, `alert`, `dialog`,
`alertdialog`, `main`, `navigation`, `banner`, `contentinfo`, `complementary`,
`region`. The union is closed; anything else is a type error. `img` is
accepted as an alias of `image`, so a ported Playwright `getByRole('img')`
compiles and builds the `image` query. A role the platform has no widget for
(`tooltip` on a phone) matches nothing rather than failing to compile. On the
web a rich-text editor's `contenteditable` host is a `textbox` in the screen
the agent sees and takes `fill`; address one from a test with `getByLabel` or
`getByTestId`, or give the host `role="textbox"` for `getByRole`, which
resolves through Playwright's role selector.

Text matching is exact by default after whitespace normalization, and
`getByText` and `getByLabel` return the innermost match: a container that
echoes its child's text or label (an iOS Text host view around its
StaticText, a TextInput host view around its field) does not count twice.
`exact: false` is a case-insensitive substring match; a `RegExp` matches as
written.

Rules:

- An action, read, or assertion needs exactly one match. Two matches fail
  immediately with `LOCATOR_AMBIGUOUS`; zero matches poll until the timeout,
  then `LOCATOR_NOT_FOUND`. `toHaveCount`, `toBeHidden`, the list form of
  `toHaveText` and `toContainText`, and the set reads `count()`, `all()`,
  and `allTextContents()` are the exceptions.
- Narrow with `filter({ hasText })`, `filter({ has: locator })`, `first()`,
  `last()`, `nth(i)`, or by scoping under another locator.
- `visible: true` drops nodes the page hides (a closed drawer, a prerendered
  duplicate) before the exactly-one rule. Reach for it when a query is
  ambiguous even though one element is on screen.
- On the web, queries search open and closed shadow roots alike, so a control
  a widget renders in a closed root resolves like any other. `web.locator(css)`,
  `frameLocator`, and `filter({ hasText })` stop at a closed root; query the
  text inside the root or filter with `has` instead.

```ts
const row = screen.getByRole('listitem').filter({ hasText: 'Invoice 42' });
await row.getByRole('button', { name: 'Void' }).tap();
await screen.getByText('Save', { visible: true }).first().tap();
await screen.scrollUntilVisible(screen.getByRole('button', { name: 'Accept' }));
```

### Actions

Each action resolves one node, waits for it to be actionable within
`config.actionTimeout` (30 s, or `{ timeout }`), and performs one operation.

`tap()` (alias `click()`), `doubleTap()`, `longPress({ duration? })`,
`fill(value | Secret)`, `pressSequentially(text, { delay? })`, `clear()`,
`press(key)`, `check()`, `uncheck()`,
`selectOption(label | { label } | { value } | { index })`, `focus()`, `hover()`,
`setInputFiles(paths)` (relative to the project root), `dragTo(locator)`,
`scrollIntoView()`, `swipe({ direction, momentum? })`.

`fill` sets the value and fires no key events. When the app reacts to
keystrokes (autocomplete, search-as-you-type, a masked input), use
`pressSequentially`: it focuses the field and types through the keyboard, one
character per call with `delay`. It takes a plain string only; a `Secret` is
`INVALID_ARGUMENT` and goes through `fill`.

Coordinates, in CSS pixels, for what the tree does not list: `tap({ position:
{ x, y } })` taps at an offset of the node's top-left corner;
`screen.tapAt({ x, y })` taps a viewport point
with no node behind it; `screen.swipe({ from, to })` swipes along a path
between two points (a touch swipe on a device, a pointer drag in a browser),
next to the directional `screen.swipe({ direction, momentum? })`. Prefer a
locator when one exists; a point moves with the layout.

### Reads

Reads resolve once and do not retry: `textContent()`, `inputValue()`,
`getAttribute(name)`, `isVisible()`, `isHidden()`, `isEnabled()`,
`isDisabled()`, `isChecked()`, `boundingBox()`, `count()`. `all()` gives one
`nth(i)` locator per current match and `allTextContents()` every match's
text; both are `[]` for zero matches. `waitFor({ state?: 'visible' |
'hidden', timeout? })` waits for a state. When a value has to settle, use
`expect` instead of a read. Reading a password field's value is
`POLICY_DENIED`.

```ts
for (const row of await screen.getByRole('row').all()) {
  await row.getByRole('checkbox').check();
}
```

## expect

`expect(locator)` polls for up to `config.assertionTimeout` (5 s) or
`{ timeout }`; `.not` inverts. `expect(web)` gives the browser matchers.
`expect(value)` is synchronous. `expect.poll(read, { timeout?, interval?,
message? })` re-reads a value until a value matcher passes
(`assertionTimeout` and 100 ms by default, stopping with the attempt); a
throwing read keeps polling, and it is not a report step. `expect.soft(x)`
has the same matchers but keeps a failure instead of throwing; the attempt
fails after the body with every soft failure listed. `expect.any(Class)`,
`expect.anything()`, `expect.objectContaining(obj)`,
`expect.arrayContaining(arr)`, `expect.stringContaining(s)`, and
`expect.stringMatching(s | RegExp)` stand in for values inside `toEqual`,
`toMatchObject`, `toContain`, and `toHaveProperty`.

```ts
await expect(screen.getByRole('status')).toHaveText('Saved');
await expect(screen.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
await expect(screen.getByTestId('todo')).toHaveCount(3);
await expect(web).toHaveURL('/dashboard');   // relative to the base URL, or a RegExp
await expect(web).toHaveTitle(/Dashboard/);
expect(await screen.getByTestId('total').textContent()).toContain('$');
await expect.poll(() => db.orders.count(), { timeout: 15_000 }).toBe(1);   // re-reads until it holds
expect(order).toMatchObject({ id: expect.any(Number), lines: [{ sku: 'a' }] });
expect.soft(await screen.getByTestId('tax').textContent()).toBe('$8.00');  // kept, body runs on
```

| Locator matchers | Web matchers | Value matchers |
| --- | --- | --- |
| `toBeVisible`, `toBeHidden`, `toBeAttached`, `toBeEnabled`, `toBeDisabled`, `toBeChecked`, `toBeSelected`, `toBeExpanded`, `toBeFocused`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveAttribute`, `toHaveCount`, `toHaveAccessibleName` | `toHaveURL`, `toHaveTitle`, `toHaveClass` | `toBe`, `toEqual`, `toMatchObject`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toBeDefined`, `toHaveLength`, `toHaveProperty`, `toContain`, `toMatch`, `toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`, `toBeCloseTo` |

`toHaveText` compares the whole normalized text; `toContainText` a
substring or a RegExp; `toHaveValue` compares a form control's value as it
is, whitespace included, and fails on a node that has none. On a secure
field such as a password input all three are `POLICY_DENIED`, never a
comparison against `''`. Both text matchers take a list to check every match at once:
`toHaveText(['Alpha', /^Beta/])` needs exactly two matches with those texts
in order. `toBeAttached` waits for a match to exist, hidden or not. A failed
matcher is `ASSERTION_FAILED`, exit code 1.

A test that takes only `app` opens no page and calls no model; the browser
the worker launched and the context per attempt are still paid. Check an
API with `fetch` against `app.baseUrl` and the value matchers, in the same
suite as the UI tests: one run starts the app once and one report covers
both. A request helper is a `test.extend` fixture; read `web.cookies()`
inside it when the API needs the signed-in session.

```ts
test('GET /api/users returns the seeded users', async ({ app }) => {
  const response = await fetch(new URL('/api/users', app.baseUrl));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject([{ name: 'Ada' }, { name: 'Grace' }, { name: expect.any(String) }]);
});
```

## Sign-in sessions

Sign in once in a setup test, save the state under a name, and let other
tests declare it. Selecting a dependent test alone still runs its setup.

```ts
// tests/auth.setup.e2e.ts
import { test } from '@e2edev/web';
import { expect, credentials } from 'e2e';

test.setup('authenticate as admin', { sessions: ['admin'] }, async ({ app, screen, session, web }) => {
  const admin = credentials.user('admin');
  await app.open('/login');
  await screen.getByLabel('Email').fill(admin.username);
  await screen.getByLabel('Password').fill(admin.password);
  await screen.getByRole('button', { name: 'Sign in' }).tap();
  await expect(web).toHaveURL('/dashboard'); // prove the sign-in worked before saving
  await session.save('admin');
});
```

```ts
// tests/dashboard.e2e.ts
import { test, expect } from 'e2e';

test('the dashboard opens directly', { session: 'admin' }, async ({ app, screen }) => {
  await app.open('/dashboard');
  await expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

- Setup tests are top-level (not inside `describe`); exactly one setup saves
  a given name; the body saves every declared name once (`SESSION_CONTRACT`
  otherwise).
- A session holds cookies, local storage, and IndexedDB, for one run only.
  The files are encrypted and deleted at cleanup. Server state is not part of
  it.
- Credentials live in the config; values come from the environment:

```ts
credentials: {
  admin: { username: 'admin@example.test', password: process.env.ADMIN_PASSWORD ?? '' },
},
```

`E2E_USER_ADMIN_USERNAME` and `E2E_USER_ADMIN_PASSWORD` override either
field per run. `credentials.user('admin').password` is a `Secret` with no
plaintext accessor; only `fill()` and `agent.act` params accept it. Any other
sensitive value (an API key, a token) is a `secrets` entry,
`secrets: { 'stripe-key': process.env.STRIPE_KEY ?? '' }`, overridable with
`E2E_SECRET_STRIPE_KEY`; `secrets.get('stripe-key')` is the same kind of
handle and fills any editable input, with the value redacted by name
everywhere the runner writes. Once a
secret is filled, model pixels and assertion screenshots are withheld for
the rest of that session, including later tests sharing a serial session.
`app.screenshot()` fails with `POLICY_DENIED` before capture. Sign in inside
a setup test and keep the evidence in the tests that matter.

## The web fixture (browser only)

Import `test` from `@e2edev/web`. Prefer `app` and `screen`; use
`web` for what only a browser has. Portable suites declare
`requires: ['web']` so device targets skip the test instead of failing.

| Method | Does |
| --- | --- |
| `goto(url, { waitUntil? })`, `reload()`, `back()`, `forward()` | Navigation. `goto` accepts a path relative to the base URL. |
| `url()`, `title()`, `waitForURL(url \| RegExp)` | Reads and a URL wait. |
| `locator(css)` | Raw CSS or XPath. Not portable; a last resort. |
| `frameLocator(css)` | A `Screen` scoped to one iframe: `web.frameLocator('#payment').getByLabel('Card number')`. The scope keeps `locator(css)` for unnamed controls inside the frame and `frameLocator(css)` for a nested frame. |
| `evaluate(fn, arg?)` | Runs serialized code in the page. JSON in and out only, no closures. |
| `route(pattern, handler)`, `unroute(pattern)` | Intercept requests: `route.fulfill({ json })`, `route.continue()`, `route.abort()`. |
| `waitForResponse(pattern)` | Resolves with `{ url, status, headers, json(), text() }`; `text()` and `json()` reject with `ACTION_FAILED` when the body could not be read. |
| `cookies()`, `setCookies([...])` | Read and set cookies; a target is an http(s) URL or a domain. |
| `setViewport({ width, height })` | Resize. |
| `onDialog('accept' \| 'dismiss' \| handler)` | Returns an unsubscribe function. Register it before the tap that opens the dialog. |
| `waitForDownload(() => trigger)` | Returns `{ path, suggestedFilename }`. |
| `keyboard.press(key)`, `keyboard.type(text)`, `mouse.*` | Unfocused input. Prefer `locator.press` and `locator.fill`. |

```ts
await web.route('**/api/quote', (route) => route.fulfill({ json: { cents: 4200 } }));
const response = await web.waitForResponse('**/api/orders');
expect(response.status).toBe(201);
```

## Patterns that keep suites honest

- Find selectors in the source, not by guessing: read the component or
  template for labels, roles, and text. Add an `aria-label` or a heading
  where the app has no accessible name, rather than falling back to CSS.
- Create the data a test needs under a name unique to the run
  (`Invoice ${Date.now()}`) and clean up in `afterEach`. Replays and retries
  then never trip over leftovers.
- One flow across several tests: `test.describe('...', { serial: true })`.
  Otherwise tests are independent and may run on different workers.
- Tag by area and by cost (`smoke`, `billing`, `agent`) and run subsets with
  `--tag`.
- Drive flows with `agent.act` and pin each outcome with `expect`. The
  calls on this page are for exact values and exact checks; the `agent`
  topic covers the steps that do the work.

## Mistakes to avoid

- Sleeps or manual polling loops. Use a matcher with a longer `timeout`.
- A step call without `await`. The body returns while the step runs and
  the attempt fails with `STEP_NOT_AWAITED` at the line of the call.
- `web.locator('.btn-primary')` when `getByRole('button', { name })` exists.
- `expect(await locator.textContent()).toBe(...)` for a value that is still
  changing; use `toHaveText`.
- Hardcoded passwords or tokens.
- Sharing state between tests without `serial`.
- `test.only` left in a file: CI fails with `ONLY_IN_CI`.
- Asserting an exact sentence a model produced; assert the fact with
  `toContain`.
