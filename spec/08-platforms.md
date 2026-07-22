# 08 — Cross-Platform Targets

`e2e` is a cross-platform testing framework. The same test can run on web,
iOS, and Android. This works because the entire API — `agent.*`, `screen`
queries, `app`, resources — is platform-agnostic by design. The only
platform-specific fixture is `device` (mobile system utils).

## Mental model

> A test describes a **user workflow**. A **target** decides where it runs.

```ts
import { test, expect, email } from 'e2e';

export default test('email signup works', async ({ agent, app }) => {
  const inbox = email.inbox('signup');

  await app.open();

  await agent.act('create an account using this email', {
    email: inbox.address,
  });

  const code = await inbox.code();

  await agent.act('enter the verification code', { code });

  await agent.assert('the user is signed in and sees the dashboard');
});
```

This test runs unchanged on web, iOS, and Android. `app.open()` navigates to
`app.url` on web and launches the app binary on mobile.

## Targets

Declared in config, Playwright-projects style:

```ts
// e2e.config.ts
export default defineConfig({
  targets: [
    { name: 'web', platform: 'web', browser: 'chromium', url: process.env.APP_URL },
    { name: 'ios', platform: 'ios', app: 'build/MyApp.app', device: 'iPhone 16' },
    { name: 'android', platform: 'android', app: 'build/app-release.apk', device: 'Pixel 9' },
  ],
});
```

```bash
npx e2e run                  # all targets
npx e2e run --target ios
npx e2e run --target web,android
```

With no `targets` config, a single implicit web target is used (`app.url` /
`APP_URL`) — the happy path stays zero-config.

### Target shape

```ts
type Target =
  | {
      name?: string;
      platform: 'web';
      driver?: 'playwright' | 'agent-browser' | Driver;  // default: 'playwright'
      browser?: 'chromium' | 'firefox' | 'webkit';
      url?: string;               // overrides app.url
      viewport?: { width: number; height: number };
    }
  | {
      name?: string;
      platform: 'ios';
      driver?: 'agent-device' | 'appium' | Driver;       // default: 'agent-device'
      app: string;                // .app / .ipa path, or bundle id of installed app
      device?: string;            // simulator/device name, default: latest iPhone
      os?: string;                // e.g. '26.0'
    }
  | {
      name?: string;
      platform: 'android';
      driver?: 'agent-device' | 'appium' | Driver;       // default: 'agent-device'
      app: string;                // .apk path or applicationId
      device?: string;            // emulator/device name
      os?: string;                // API level / version
    };
```

Automation backends per target are switchable via `driver` — bundled ids or
driver-package instances (`driver: hyperdrive()`), built on the public
`e2e/driver` SPI. See 09-drivers.md. Defaults mean most users never set it.

## Fixtures per platform

| Fixture | web | ios | android | Notes |
|---|---|---|---|---|
| `agent` | ✅ | ✅ | ✅ | drives browser DOM or native accessibility tree |
| `app` | ✅ | ✅ | ✅ | platform-agnostic app handle (open, restart, deepLink) |
| `screen` | ✅ | ✅ | ✅ | cross-platform deterministic queries — zero AI |
| `device` | ❌ | ✅ | ✅ | mobile system utils (push, permissions, location) |
| `platform` | ✅ | ✅ | ✅ | `'web' \| 'ios' \| 'android'` for branching |

Resources (`email`, `credentials`, `webhook`, `phone`) are platform-agnostic.

## `screen` — cross-platform deterministic queries

The React Native model: one set of primitives, each platform implements
them natively. `screen` is a **projection layer, not an automation engine**
— queries delegate to the target's backend automation (browser locators on
web, accessibility queries on mobile), with the backend's own auto-waiting
and actionability checks. `e2e` implements the mapping, nothing else.
Which backend a driver uses is internal — no backend object is exposed
(an unpack escape hatch may come later; deliberately not in v0).

```ts
export default test('settings toggle persists', async ({ app, screen }) => {
  await app.open('/settings');

  await screen.getByRole('switch', { name: 'Email notifications' }).tap();
  await app.restart();

  await expect(screen.getByRole('switch', { name: 'Email notifications' })).toBeChecked();
});
```

Zero model calls, runs unchanged on web, iOS, and Android.

### Queries

Testing Library's grammar, lazy auto-retrying locators:

```ts
type Screen = {
  getByRole(role: Role, options?: RoleOptions): Locator;
  getByLabel(text: TextMatch, options?: TextMatchOptions): Locator;
  getByPlaceholder(text: TextMatch, options?: TextMatchOptions): Locator;
  getByText(text: TextMatch, options?: TextMatchOptions): Locator;
  getByDisplayValue(value: TextMatch, options?: TextMatchOptions): Locator;
  getByTestId(id: string): Locator;   // last resort
};
```

- **Query priority** (Testing Library's, unchanged): role > label >
  placeholder > text > displayValue > testId. A gradient of user
  observability; also the agent's selector policy for cached paths.
- **TextMatch**: `string | RegExp`, `{ exact?: boolean }`, trim + collapse
  whitespace always applied.
- **RoleOptions mirror matchers**: `{ name?, checked?, disabled?,
  selected?, expanded? }` — one semantic model for querying and asserting,
  dual-source per platform (`aria-*` / `accessibilityState.*`), normalized.
- **Ambiguity throws** at action time ("found 3 buttons named Submit") —
  use `.first()` / `.nth()` / `.count()`. **Absence is asserted**, not
  queried: `expect(screen.getByText('Error')).not.toBeVisible()`.
- **Scoping is chaining**: `screen.getByRole('listitem').nth(2).getByRole('button')`.

### Selector mapping (driver contract)

| Query | web | iOS | Android |
|---|---|---|---|
| `getByRole` | ARIA role + name | accessibility traits + label | `AccessibilityNodeInfo` |
| `getByLabel` | `aria-label` / `<label>` | `accessibilityLabel` | `contentDescription` |
| `getByPlaceholder` | `placeholder` | `TextInput` placeholder | hint |
| `getByText` | visible text | text content | text |
| `getByDisplayValue` | input value | `TextInput` value | input value |
| `getByTestId` | `data-testid` | `accessibilityIdentifier` (RN `testID`) | `resource-id` |

Roles are an e2e-owned vocabulary matched literally per platform:
`'button' | 'link' | 'textbox' | 'checkbox' | 'switch' | 'slider' | 'image' | 'heading' | 'tab' | 'menuitem' | 'alert'`.

### Locators

```ts
type Locator = Screen & {   // locators are also scopes: chaining = within()
  // cross-platform actions — actionability delegated to the backend
  tap(options?: { timeout?: number }): Promise<void>;   // click() alias
  fill(value: string): Promise<void>;
  longPress(options?: { duration?: number }): Promise<void>;
  scrollIntoView(): Promise<void>;

  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  first(): Locator;
  nth(index: number): Locator;
};
```

Growth rule: a method is added only if **all** platforms can project it
faithfully onto their backend. There is deliberately no backend escape
hatch in v0 — if a capability matters, it earns a cross-platform primitive
(or an issue), rather than leaking a backend object into tests.

### `app` — the portable app handle

```ts
type App = {
  /** Navigate to app.url (web) or launch the app (mobile). */
  open(path?: string): Promise<void>;
  /** Kill and relaunch (mobile) / new context + goto (web). */
  restart(): Promise<void>;
  /** Open a deep link / universal link on any platform. */
  deepLink(url: string): Promise<void>;
  /** Evidence screenshot for the report, any platform. Returns artifact path. */
  screenshot(label?: string): Promise<string>;
};
```

### `device` — mobile system utils (mobile targets)

Element interaction lives on `screen` (deterministic) or `agent` (agentic);
`device` carries only thin system utilities neither can express:

```ts
type Device = {
  platform: 'ios' | 'android';

  /** System-level actions. */
  home(): Promise<void>;
  openUrl(url: string): Promise<void>;
  setLocation(lat: number, lng: number): Promise<void>;
  setPermission(permission: 'camera' | 'location' | 'notifications' | 'contacts', state: 'allow' | 'deny'): Promise<void>;

  /** Push notification injection (simulator/emulator; managed devices in Cloud). */
  pushNotification(payload: Record<string, unknown>): Promise<void>;
};
```

## Constraining tests to platforms

Tests that use `device` or exercise a platform-specific flow declare their
platforms; the runner skips non-matching targets (reported as
skipped-per-target, not failed):

```ts
export default test('push notification opens thread', { platforms: ['ios', 'android'] }, async ({ device, agent }) => {
  await device.pushNotification({ threadId: '42' });
  await agent.assert('the message thread is open');
});
```

Branching inside a shared test:

```ts
export default test('settings are reachable', async ({ agent, platform }) => {
  if (platform === 'web') {
    await agent.act('open settings from the sidebar');
  } else {
    await agent.act('open settings from the tab bar');
  }
  await agent.assert('the settings screen is visible');
});
```

Type-level rule: `device` is typed as always present in fixtures, but
accessing it on a web target throws a clear error telling you to add
`platforms: […]`. (Alternative — conditional fixture types via
`test.web()` / `test.mobile()` — was rejected: it forks the primitive.)

## How the agent works on mobile

Same contract as web: `agent.act()` sees the screen (screenshot + native
accessibility tree instead of DOM) and performs steps via the native driver.
`agent.assert()` judges the current screen. `AgentStep`/`AgentError`/artifact
semantics are identical across platforms.

## Reporting

Each (test × target) pair is a separate result:
`email signup works [web]`, `email signup works [ios]`. Artifacts are
per-target: video/screenshots on mobile, trace/video on web.

## Ship order

- **v0:** web targets only. But: `app`, `screen`, `platform`, `targets`,
  and `platforms` ship in the type surface from day one so tests written
  portably today run on mobile without edits later.
- **v1:** iOS + Android on local simulators/emulators (OSS).
- **Cloud:** managed real-device fleet, OS/device matrix, parallel targets.
