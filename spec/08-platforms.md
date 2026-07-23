# 08 — Cross-Platform Targets

`e2e` is a cross-platform testing framework. The same test can run on web,
iOS, and Android — and on platforms that don't exist yet (Electron,
desktop, TV): the platform set is open, extended by driver packages. This
works because the entire API — `agent.*`, `screen` queries, `app`,
resources — is platform-agnostic by design. The only platform-specific
fixtures are capabilities (`web`, `device`) provided per driver.

## Mental model

> A test describes a **user workflow**. A **target** decides where it runs.

```ts
import { test, credentials } from 'e2e';

export default test('admin can invite a teammate', async ({ agent, app }) => {
  await app.open();

  await agent.login(credentials.user('admin'));

  await agent.act('invite a teammate as viewer', {
    email: 'ada@example.test',
  });

  await agent.assert('the pending invite for ada@example.test is listed');
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
/** Open vocabulary: official ids get autocomplete, any driver-provided id is valid. */
type Platform = 'web' | 'ios' | 'android' | (string & {});

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
    }
  // Any other platform is introduced by a driver package (09-drivers.md).
  // Its target options live on the driver factory, fully typed by that
  // package — not as loose fields here.
  | {
      name?: string;
      /** Inferred from the driver when it supports exactly one platform. */
      platform?: string;
      driver: Driver;
    };
```

Automation backends per target are switchable via `driver` — bundled ids or
driver-package instances (`driver: hyperdrive()`), built on the public
`e2e/driver` SPI. See 09-drivers.md. Defaults mean most users never set it.

### Platforms are an open set

`'web' | 'ios' | 'android'` are the official ids with bundled default
drivers. Any other platform — Electron, desktop, TV — is introduced by a
driver package, with **no core release required**:

```ts
import { electron } from 'e2e-driver-electron';

export default defineConfig({
  targets: [
    { name: 'web', platform: 'web' },
    { name: 'desktop', driver: electron({ main: 'out/main.js' }) }, // platform: 'electron'
  ],
});
```

The portable API is the fixed contract; the platform list is not. A new
platform must implement the driver SPI (project `screen` queries onto its
accessibility layer, provide observation and actions, pass `verifyDriver`)
— and every portable test runs on it unchanged. String platform ids
resolve to bundled drivers only; new platforms always arrive as driver
instances.

## Fixtures per platform

| Fixture | web | ios | android | Notes |
|---|---|---|---|---|
| `agent` | ✅ | ✅ | ✅ | drives browser DOM or native accessibility tree |
| `app` | ✅ | ✅ | ✅ | platform-agnostic app handle (open, restart, deepLink) |
| `screen` | ✅ | ✅ | ✅ | cross-platform deterministic queries — zero AI |
| `web` | ✅ | ❌ | ❌ | web-only deterministic surface (navigation, css, network) |
| `device` | ❌ | ✅ | ✅ | mobile system utils (push, permissions, location, keyboard) |
| `platform` | ✅ | ✅ | ✅ | the target's platform id, for branching |

`agent`, `app`, and `screen` are universal — every driver must provide
them. `web` and `device` are **driver capabilities, not platform
hardcodes**: `web` is present wherever the driver provides the web surface
(browsers — and, say, an Electron driver, which is Chromium underneath);
`device` wherever it provides mobile system utils. Accessing a capability
the current target's driver doesn't provide throws a clear, actionable
error.

Resources (`credentials` in v0; extensions later) are platform-agnostic.

## How the surface scales

The deterministic surface is layered so it grows without forking per
platform:

1. **The portable core is the intersection.** `screen` queries, `Locator`
   actions/reads, `app` lifecycle. Grows only under the growth rule below:
   every platform must project a method faithfully. Deliberately small.
2. **Everything platform-specific is a capability.** Web-only power lands
   on `web`, mobile-only on `device` — the union never pollutes the core.
   New platform families bring their own capabilities via driver packages
   (roadmap: driver-provided fixtures).
3. **The agent tier is the pressure valve.** The deterministic surface
   doesn't have to express the long tail — canvas, maps, native pickers,
   OS dialogs — `agent.*` covers it in natural language, and the locate
   cache converges hot paths back into deterministic `screen` replays.
   This is why the core can stay small where selector-only frameworks had
   to sprawl.

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
  swipe(options: SwipeOptions): Promise<void>;
  scrollUntilVisible(target: Locator, options?: { direction?: ScrollDirection; timeout?: number }): Promise<void>;
};

type ScrollDirection = 'up' | 'down' | 'left' | 'right';
type Momentum = 'none' | 'slow' | 'fast';
type SwipeOptions = { direction: ScrollDirection; momentum?: Momentum };
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

Lazy, auto-retrying element handles (the backend's waiting/actionability
mechanics). The surface deliberately covers the Playwright ∩ Maestro union —
see 12-migration.md. `Locator` extends `Screen`: every locator is also a
query scope (chaining = `within()`).

```ts
type Locator = Screen & {
  // Actions — actionability-checked: acting on hidden/disabled/covered
  // elements fails with an actionable error, never a silent no-op.
  tap(options?: { timeout?: number }): Promise<void>;
  /** Alias of tap() for web muscle memory. */
  click(options?: { timeout?: number }): Promise<void>;
  doubleTap(options?: { timeout?: number }): Promise<void>;
  longPress(options?: { duration?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  clear(): Promise<void>;
  press(key: string): Promise<void>;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  /** Native <select> on web; picker on mobile. */
  selectOption(value: string | { label?: string; index?: number }): Promise<void>;
  focus(): Promise<void>;
  dragTo(target: Locator): Promise<void>;
  scrollIntoView(): Promise<void>;
  /** Swipe gesture scoped to this element. */
  swipe(options: SwipeOptions): Promise<void>;

  // Reads
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  count(): Promise<number>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;

  // Refinement
  filter(options: { hasText?: TextMatch; has?: Locator }): Locator;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
};
```

Growth rule: a method joins `Locator` only if **all** platforms can project
it faithfully onto their backend. Web-only capabilities go to `web`;
mobile-only to `device`. There is no backend escape hatch — if a capability
matters, it earns an e2e-owned primitive. The vocabulary is governed here,
by the official platforms; a new platform projects it (verified by the
conformance suite), it doesn't fork it.

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

```ts
type Web = {
  // navigation — relative URLs resolve against app.url
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  url(): string;
  title(): Promise<string>;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;

  /** CSS/XPath escape hatch — web-only by nature; prefer screen.getBy*. */
  locator(selector: string): Locator;
  /** Scoped queries inside an iframe. */
  frameLocator(selector: string): Screen;

  evaluate<T>(fn: string | (() => T)): Promise<T>;

  // network interception
  route(pattern: string | RegExp, handler: (route: WebRoute) => void | Promise<void>): Promise<void>;
  unroute(pattern: string | RegExp): Promise<void>;
  waitForResponse(pattern: string | RegExp, options?: { timeout?: number }): Promise<WebResponse>;

  // browser state
  cookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
  setViewport(size: { width: number; height: number }): Promise<void>;

  // events
  onDialog(handler: 'accept' | 'dismiss' | ((dialog: { message: string; accept(text?: string): Promise<void>; dismiss(): Promise<void> }) => void)): void;
  waitForDownload(trigger: () => Promise<void>): Promise<{ path: string; suggestedFilename: string }>;

  // raw input (web only — no cross-platform equivalent)
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  };
  mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
};

type WebRoute = {
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  fulfill(response: { status?: number; json?: unknown; body?: string; headers?: Record<string, string> }): Promise<void>;
  continue(): Promise<void>;
  abort(): Promise<void>;
};

type WebResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
};

type Cookie = { name: string; value: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' };
```

Plus `expect(web).toHaveURL/toHaveTitle` (03-assertions.md).

The Maestro-side equivalents (app lifecycle, permissions, system gestures)
live on `app` and `device`. Together, `screen` + `web` + `app` + `device`
form the deterministic surface with full Playwright *and* Maestro parity —
see 12-migration.md for the mapping tables.

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

  /** Push notification injection (simulator/emulator). */
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

Type-level rule: capability fixtures (`web`, `device`) are typed as always
present, but accessing one the current target's driver doesn't provide
throws a clear error telling you to add `platforms: […]`. (Alternative —
conditional fixture types via `test.web()` / `test.mobile()` — was
rejected: it forks the primitive.)

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
- **Beyond:** new platforms (Electron, desktop, TV, …) arrive as driver
  packages on the open platform model — the core never gates them.
  Managed device fleets are part of the cloud roadmap (roadmap/cloud.md).
