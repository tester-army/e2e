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
| `web` | ✅ | ❌ | ❌ | web-only deterministic surface (navigation, css, network) |
| `device` | ❌ | ✅ | ✅ | mobile system utils (push, permissions, location, keyboard) |
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

  // cross-platform gestures (Maestro heritage; touch/trackpad on web)
  swipe(options: { direction: ScrollDirection; momentum?: Momentum }): Promise<void>;
  scrollUntilVisible(target: Locator, options?: { direction?: ScrollDirection; timeout?: number }): Promise<void>;
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
`'button' | 'link' | 'textbox' | 'checkbox' | 'switch' | 'slider' | 'image' | 'heading' | 'tab' | 'menuitem' | 'listitem' | 'status' | 'dialog' | 'alert'`.

### Locators

The full surface is normative in `api.d.ts`; it deliberately covers the
Playwright ∩ Maestro union — see 12-migration.md:

- **Actions**: `tap`/`click`, `doubleTap`, `longPress`, `fill`, `clear`,
  `press`, `check`/`uncheck`, `selectOption`, `focus`, `dragTo`,
  `scrollIntoView`, `swipe`
- **Reads**: `textContent`, `inputValue`, `getAttribute`, `isVisible`,
  `isEnabled`, `isChecked`, `boundingBox`, `count`, `waitFor`
- **Refinement**: `filter({ hasText, has })`, `first`/`last`/`nth`,
  chaining (= `within()`)

Growth rule: a method joins `Locator` only if **all** platforms can project
it faithfully onto their backend. Web-only capabilities go to `web`;
mobile-only to `device`. There is no backend escape hatch — if a capability
matters, it earns an e2e-owned primitive.

### `app` — the portable app handle

```ts
type App = {
  /** Navigate to app.url (web) or launch the app (mobile). */
  open(path?: string): Promise<void>;
  /** Kill and relaunch (mobile) / new context + goto (web). Does NOT clear persisted data. */
  restart(): Promise<void>;
  /** Wipe persisted app data (web: cookies/storage; mobile: app data), then relaunch. */
  clearState(): Promise<void>;
  /** System back: Android hardware back / browser history / iOS back gesture. */
  back(): Promise<void>;
  /** Open a deep link / universal link on any platform. */
  deepLink(url: string): Promise<void>;
  /** Evidence screenshot for the report, any platform. Returns artifact path. */
  screenshot(label?: string): Promise<string>;
};
```

Note the `restart()`/`clearState()` split: on mobile, killing and
relaunching an app does **not** remove device-saved data (defaults,
keychain, storage). Tests that need a factory-fresh app must use
`clearState()`; `restart()` is for "cold start with existing state".

### `web` — web-only deterministic surface (web targets)

Playwright-parity capabilities that have no mobile meaning. Still e2e-owned
and driver-projected — no backend object is exposed. Using `web` constrains
the test to web (`platforms: ['web']`).

```ts
export default test('checkout with stubbed flags', { platforms: ['web'] }, async ({ web, screen, agent }) => {
  await web.route('**/api/flags', r => r.fulfill({ json: { beta: true } }));
  await web.goto('/pricing');

  await screen.getByRole('button', { name: 'Annual' }).tap();
  await web.waitForURL(/checkout/);

  await agent.assert('the annual discount is applied');
});
```

Surface (normative in `api.d.ts`): navigation (`goto`, `reload`, `back`,
`forward`, `url`, `waitForURL`), `locator(css)`, `frameLocator`, `evaluate`,
network interception (`route`, `waitForResponse`), `cookies`/`setCookies`,
`setViewport`, dialogs (`onDialog`), downloads (`waitForDownload`), raw
`keyboard`/`mouse`. Plus `expect(web).toHaveURL/toHaveTitle`.

The Maestro-side equivalents (app lifecycle, permissions, system gestures)
live on `app` and `device`. Together, `screen` + `web` + `app` + `device`
form the deterministic surface that replaces Playwright *and* Maestro — see
12-migration.md for the mapping tables.

### `device` — mobile system utils (mobile targets)

Element interaction lives on `screen` (deterministic) or `agent` (agentic);
`device` carries only thin system utilities neither can express:

```ts
type Device = {
  platform: 'ios' | 'android';

  /** System-level actions. */
  home(): Promise<void>;
  hideKeyboard(): Promise<void>;
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
