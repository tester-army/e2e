# Setting up e2e

## Requirements

- Node.js 22.12 or newer.
- ES modules: `.ts` config, tests, helpers, and workspace packages exporting
  `.ts` source load as ESM regardless of the nearest `package.json` `type`
  (CommonJS packages need no change); never `require` or `module.exports`.
- Browser tests: `@e2e-dev/web` plus `playwright` (`>=1.63.0 <2`), a peer the
  engine does not install: an existing Playwright keeps its version and
  browser cache, one out of range fails install as an unmet peer (npm's
  `ERESOLVE`): upgrade `playwright` within the range. Missing
  browsers download on first boot; in CI run `npx playwright install chromium
  --with-deps`. Mobile tests: `@e2e-dev/mobile`, pinning `agent-device`
  exactly; the pin moves with each engine release.

## Scaffold

Fresh project:

```bash
npx e2e init       # npm
pnpm dlx e2e init  # pnpm
```

With `e2e` installed, run the installed version: `npx e2e init` or `pnpm exec
e2e init`; `npx e2e init my-app` scaffolds into a new directory.

The wizard picks an engine and a model provider (None for tests without AI)
and offers to install this skill, register the MCP server for your coding
agent, and install dependencies. `--yes` picks Playwright and Vercel AI
Gateway, installs the skill in `.agents/skills/` (`.claude/skills/e2e`
symlinks to it), registers MCP in `.mcp.json` and `.cursor/mcp.json`, skips
installing dependencies.

Init adds dependencies and a `test:e2e` script to `package.json`, writes
`e2e.config.ts` and `tests/example.e2e.ts`, updates `.gitignore`, leaves
existing configs and tests alone. Re-run after upgrading to refresh skill and
MCP entries.

Without the wizard (`ai`, Vercel AI SDK v7, only for `agent.*` steps):

```bash
npm install --save-dev e2e @e2e-dev/web playwright ai@^7
```

## Subscriptions and API keys

`e2e init` writes model config and dependencies for a subscription, an API
key, or a local endpoint. Authenticate:

| Choice | Setup |
| --- | --- |
| ChatGPT Plus or Pro | `npx e2e login openai` |
| GitHub Copilot | `npx e2e login github-copilot` (GitHub CLI signed in, or your own `--client-id`) |
| SuperGrok or X Premium+ | `npx e2e login spacexai` |
| Vercel AI Gateway | Set `AI_GATEWAY_API_KEY`, or sign in to the Vercel CLI and `npx vercel link`; without the key `gateway()` uses a Vercel OIDC token |
| OpenRouter | Set `OPENROUTER_API_KEY` |
| Local or self-hosted endpoint | Set the endpoint URL and a model it serves, plus a key if required |

Switching an existing config to ChatGPT: install `ai` and `@ai-sdk/openai`,
set `model: chatgpt('gpt-6-luna')` from `e2e/oauth/chatgpt`, run `npx e2e
login openai`. `npx e2e models` lists the ids each login serves. Use API keys
in CI.

## The config

`e2e.config.ts` sits at the project root and default-exports an object literal
ending in `satisfies E2EConfig`; unknown keys are `INVALID_CONFIG` at load.

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      engine: web(),
      app: {
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], log: '.e2e/logs/app.log' },
      },
    },
  ],
  // Model behind every agent.* step.
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      system: 'You are a thorough QA agent. Verify every outcome on screen.',
    },
  },
  credentials: {
    admin: { username: 'admin@example.test', password: process.env.ADMIN_PASSWORD ?? '' },
  },
} satisfies E2EConfig;
```

A string `password` is checked at load (6+ code points): set `ADMIN_PASSWORD`
or `E2E_USER_ADMIN_PASSWORD` first, or defer to fill time with
`() => process.env.ADMIN_PASSWORD ?? ''`.

| Key | Default | Notes |
| --- | --- | --- |
| `targets` | required | Non-empty; `--target` takes `name`. UI targets set `engine` and `app` (`platform` and `name` default to the engine's platform); tools-only targets may omit `engine` and must set `platform`. |
| `tests` | `'tests/**/*.e2e.ts'` | Globs relative to the project root (optional `./`): `*`, `?`, whole `**` segments, leading `!` excludes (`'!tests/wip/**'`; only exclusions is `INVALID_CONFIG`). Braces, character classes, extglobs, `..`, absolute paths, and a wildcard-free directory entry (`'!tests/wip'`) are `INVALID_GLOB`. |
| `timeout` | `120000` | Per test attempt, ms; also the default `agent.act` deadline. |
| `launchTimeout` | `60000` | Engine init and attempt start, ms. |
| `actionTimeout` | `30000` | Each locator action and engine operation, agent-step observations included. |
| `assertionTimeout` | `5000` | `expect` polling window. |
| `cleanupTimeout` | `30000` | Each `afterEach` hook, fixture teardown, engine cleanup, ms. |
| `retries` | `0`, `1` in CI | 0 to 10. |
| `workers` | half the cores, `1` in CI | Parallel test files, capped by the `workers` the engine declares per target. |
| `reporters` | `['list']` | `list`, `json`, `junit`, `markdown`, or `{ name, onEvent?, onRunFinished? }` objects; `json` excludes `list`, `--reporter` keeps the objects. |
| `cache` | `'read-write'` | `'read-write'`, `'read-only'`, `'off'`, or `{ mode, store, dir, strict }`; CI demotes only a defaulted mode to `'read-only'`. `strict` (`--strict-cache`) fails a step whose recording no longer replays (`REPLAY_STALE`) instead of handing it to the agent. |
| `agents` | `{ default: built-in }` | Tests run with `default`, `e2e run --agent <name>` picks another, entries never inherit from `default`. Options: topic `agent`. |
| `credentials` | `{}` | Named `{ username, password }`; `password` is a 6+ code point string or a function returning it. |
| `secrets` | `{}` | Named values the model never sees (API keys, tokens), same value rule. A separate namespace: a credential's password is `credentials.user(name).password` (named `<name>.password`), never `secrets.get()`, so a name may be both. |
| `output` | `'.e2e'` | Results directory; `--output <dir>` for one run. Inside the project root, not the root, not a tests glob's directory, never the cache dir (`cache.dir` stays `.e2e/cache`). |
| `artifacts` | none | `{ store }`: artifacts go to the host `ArtifactStore` (`{ put(artifact), putLink?(link) }`); `putLink` gets provider-hosted video links (never a passed `retain-on-failure` attempt's). Failure screenshots are always captured when the engine can. |
| `trace` | `'on'`, `'on-first-retry'` in CI | Attempts that record a Playwright trace: `'off'`, `'on'`, `'retain-on-failure'`, `'on-first-retry'`, `'on-all-retries'`; precedence and capability rule as `video`. |
| `video` | `'off'` | Same modes; `'retain-on-failure'` records all, keeps those that did not pass. Precedence: the test's `video`, `--video [mode]`, the target's (`{ engine, video }`), the config's. |
| `projectId` | the package name | Report and cache identity. |

- `tests` discovery enters only directories a glob can match; symlinks are
  not followed.
- `trace` and `video`: a config or flag mode skips targets whose engine
  cannot record (one notice), a target or test mode requires it
  (`UNSUPPORTED_ARTIFACT`); a retry mode with `retries: 0` prints a notice;
  neither invalidates the replay cache.

## The app under test

The target declares the app; the engine only drives it. `web({ url })`,
`mobile({ app })`, and the other old app options are unknown keys. The target's `app`:

| Key | Meaning |
| --- | --- |
| `url` | Base URL for `app.open()` and relative navigation; required on a `web()` target, not supported on a mobile target yet. Missing scheme: `https://`, `http://` for loopback; port `0` on `127.0.0.1` or `[::1]` takes a free port. A service placeholder (`url: webServer.url`) serves the target from that service. |
| `bundleId` | Device targets: the bundle id, package name, or display name (`Settings`) `app.open()` launches. |
| `appPath` | Device targets: the `.app` or `.apk` under test. A device target needs `bundleId` or `appPath`. |
| `launchArguments`, `permissions` | Device targets: arguments and permission states (`grant`, `deny`, `reset`) every fresh launch gets. |
| `command` | The process serving `url`, for this target alone: `{ executable, args, cwd, env, startupTimeout, shutdownTimeout, log, reuseExisting }`; `{port}` in `args` and `env` expands to `url`'s port. Two processes probing one fixed address are `INVALID_CONFIG`, and so is a command beside a `url` that is a service placeholder; share a process as a service. |
| `readyUrl` | Readiness probe when it differs from `url`; `{port}` expands too. The command's own address: never a service placeholder. |
| `environment` | `'test'`, `'staging'`, `'production'`; inferred from the host, labels the report and cache key. |
| `identity` | Stable identity for cache and session keys when the origin changes per deploy (preview URLs). Defaults to the URL's origin and path, else `bundleId`, else `appPath`. |

A Next.js 16 dev server blocks cross-origin requests to its dev resources, so
a target that opens `127.0.0.1` or `[::1]` while `next dev` identifies as
`localhost` never hydrates. Add the host to `allowedDevOrigins` in
`next.config.ts` (`'127.0.0.1'`, or `'[::1]'` for the bracket form). A
`localhost` target needs no entry, and a production `next start` target is
unaffected.

`services` sits on the target beside `app`: `defineService` handles started
before `app.command`, dependencies first. See [Services](#services).

`web()` options:

| Option | Meaning |
| --- | --- |
| `browser` | `'chromium'` (default), `'firefox'`, `'webkit'`, or a `BrowserProvider` leasing hosted browsers over CDP (`kernel()` from `@e2e-dev/kernel`, or your own), which implies chromium and excludes `connect`. Scope `'worker'` (default): one browser per worker slot from `prepare` to `finish`; `'attempt'`: one per attempt, with `reconnectEndpoint`'s limits. |
| `viewport` | `{ width, height }`, default 1280x720; `null` follows the browser window (hosted live view, headed run). On a headed hosted browser (Kernel) use `null` and size the service's screen; a fixed size gives a smaller, unmaximized window. |
| `connect` | `{ cdpEndpoint }` attaches to a remote Chromium over CDP; both it and `reconnectEndpoint` are resolvers `(signal) => url`, not strings. With `reconnectEndpoint` it rides one persistent default context and reconnects only to the original browser and page. |
| `headers` | Sent to the app's site only (Vercel's `x-vercel-protection-bypass`, ngrok's `ngrok-skip-browser-warning`), `agent.act` included; disables the browser HTTP cache and service workers. |
| `basicAuth` | `{ username, password }` for a `401` challenge; `password` may be `secrets.get('name')`, resolved per attempt and redacted like any secret, the base64 `Authorization` credential too. |
| `userAgent` | The `User-Agent` every attempt sends and `navigator.userAgent` reports. |
| `testIdAttribute` | What `getByTestId` reads; default `data-testid`. |
| `screencast` | `{ size?, quality? }` for the engine's own video: frame size (default the viewport's), JPEG quality 0 to 100. |

- `basicAuth` via `secrets.get()` masks text, not screenshots or model pixels
  showing the password. An undeclared name is `INVALID_CONFIG` at load, as is
  the handle (a reference, not the value) in `app.command.env`, a template
  literal, or `context`; read those from `process.env`.
- `reconnectEndpoint` or an attempt-scoped provider rides one persistent
  context without `headers`, `basicAuth`, `userAgent`, `app.clearState()`, or
  session state. Recovery never repeats a dispatched operation; exhausting
  the budget is `OPERATION_TIMEOUT`. Without `reconnectEndpoint` a dropped
  connection is reacquired at the next attempt.

Two browsers, one app declaration:

```ts
const app = { url: 'http://127.0.0.1:3000' };
export default {
  targets: [
    { name: 'chromium', engine: web(), app },
    { name: 'mobile-webkit', engine: web({ browser: 'webkit', viewport: { width: 390, height: 844 } }), app },
  ],
} satisfies E2EConfig;
```

### Let the runner start the app

Prefer `app.command` to a hand-started dev server: self-contained locally
and in CI.

```ts
engine: web(),
app: {
  url: 'http://127.0.0.1:3000',
  command: {
    executable: 'pnpm',
    args: ['dev'],
    env: { PORT: '3000', DATABASE_URL: process.env.DATABASE_URL ?? '' },
    startupTimeout: 120_000,
    log: '.e2e/logs/app.log',
  },
},
```

- The runner spawns `command`, polls `readyUrl` (default `url`) for a 200 to
  499 status within `startupTimeout` (default 60 s), and stops it when the run
  ends, fails, or is interrupted (`shutdownTimeout`, default 10 s). Never
  ready is `APP_UNREACHABLE`; `.e2e/report.json` is still written.
- The child inherits the runner's whole environment, with `command.env` on
  top, as a dev server started from the same shell would.
- Output is discarded unless `log` names a file under an ignored directory
  such as `.e2e/logs/`; without it a server dying on boot is invisible.
- A `url` answering before the spawn is `APP_ALREADY_RUNNING`;
  `command.reuseExisting: true` attaches to a running dev server (CI ignores
  it).
- `executable` resolves on `PATH`, never through a shell; name the server
  itself, not a wrapper script.
- `url: 'http://127.0.0.1:0'` (or `[::1]:0`, never `localhost:0`) takes a
  free port; the command receives it as
  `{port}` in `args` or `env` (`args: ['dev', '--port', '{port}']`), which
  also expands in `readyUrl`. Tests read the URL from `app.baseUrl`; the
  cache identity keeps `:0`. `{port}` is always the declaring process's own
  port, so in a service it is the service's. Each target with a port-0 `url`
  gets its own port and process; to share one, make it a service. A port-0
  `url` with no `command`, and `reuseExisting` beside one, are
  `INVALID_CONFIG`.
  A port grabbed between allocation and spawn fails the start with
  `APP_UNREACHABLE`; rerun.

For an app started elsewhere, point `app.url` at it, literally or via
`process.env.APP_URL ?? 'http://localhost:3000'`; the runner reads no
`APP_URL` and loads no `.env`, so put `process.loadEnvFile('.env')` atop
`e2e.config.ts` (workers re-import it).

### Services

Databases, migrations, mocks, a dev server several targets share, and
global setup code are services: declare each once with `defineService` from
`e2e` and list the handle in the `services` of every target that needs it.

```ts
import { defineService, type E2EConfig } from 'e2e';

const db = defineService({
  name: 'db',
  executable: 'docker',
  args: ['compose', 'up', '--wait', 'postgres'],
  waitForExit: true,
  teardown: { executable: 'docker', args: ['compose', 'down'] },
});
const seed = defineService({
  name: 'seed',
  dependsOn: [db],
  start: async () => { /* insert fixtures */ },
  stop: async () => { /* delete them */ },
});
const stripe = defineService({
  name: 'stripe',
  executable: 'stripe-mock',
  args: ['-http-port', '{port}'],
  readyUrl: 'http://127.0.0.1:0',
});
const mail = defineService({
  name: 'mail',
  executable: 'mailpit',
  args: ['--smtp', '127.0.0.1:{port:smtp}', '--listen', '127.0.0.1:{port:http}'],
  ports: { smtp: 0, http: 0 },
  readyUrl: 'http://127.0.0.1:{port:http}/livez',
});
const webServer = defineService({
  name: 'web-server',
  executable: 'pnpm',
  args: ['dev', '--port', '{port}'],
  env: { STRIPE_API_BASE: stripe.url, SMTP_URL: mail.urlOf('smtp') },
  readyUrl: 'http://127.0.0.1:0',
  dependsOn: [seed, stripe, mail],
});

export default {
  targets: [
    { name: 'chromium', engine: web(), app: { url: webServer.url }, services: [webServer] },
    { name: 'firefox', engine: web({ browser: 'firefox' }), app: { url: webServer.url }, services: [webServer] },
  ],
} satisfies E2EConfig;
```

- Two forms, never both: a process (`executable`, with exactly one of
  `readyUrl` or `waitForExit: true`) or a function (`start`, optionally
  `stop`) that runs in the runner process, the counterpart of global setup
  and teardown. A throwing `start`, or one past its `startupTimeout` (60 s
  by default), fails startup with `APP_UNREACHABLE` naming the service;
  Ctrl-C stops waiting on it at once. `stop` has the run's `cleanupTimeout`,
  else `CLEANUP_TIMEOUT`; a throwing `stop` is a cleanup error naming the
  service. Both receive
  `{ signal, projectRoot, services }`, `services` holding `{ url, port, ports }`
  for every dependency by name.
- `name` is required (letters, digits, `_`, `-`, at most 64) and one name is
  one service across the run. Only the handle is a service: a plain object
  or a spread copy in `services` or `dependsOn` is `INVALID_CONFIG`.
- Lifetime is the run. Every service a selected target needs, including
  everything reachable through `dependsOn`, starts once before the first
  test, each after its dependencies; then the app commands. At the end the
  runner stops the app commands, then the services in reverse, each followed
  by its `teardown` command, which runs only for a process the run spawned.
  Targets listing one service share one process; a service no selected
  target needs does not start. `dependsOn` takes handles defined earlier, so
  there is no cycle. Two processes probing one fixed address are
  `INVALID_CONFIG`.
- Ports: `readyUrl: 'http://127.0.0.1:0'` gives the service a free port,
  `{port}` in its own `args`, `env`, and `teardown`. `{port}` in a service on
  a fixed port (write the port) or without a `readyUrl` is `INVALID_CONFIG`.
  `ports: { smtp: 0 }` declares named ports (lowercase
  schemes), read as `{port:smtp}` in the service's own strings.
- Placeholders: `svc.url` (`http://127.0.0.1:54321`), `svc.port`,
  `svc.urlOf('smtp')` (`smtp://127.0.0.1:1025`), `svc.portOf('smtp')`, directly or
  in a template literal, in `args`, `env`, `teardown`, and `app.url`, never in
  a `readyUrl`. A service reads only services in its `dependsOn`
  (transitively), a target's app only services in its graph.
- Tests never see a placeholder: navigating to one is `INVALID_APP_URL`, and
  `fetch` of one fails. Navigate relative to `app.url`; read `app.baseUrl`.
- `reuseExisting` needs a `readyUrl` on a fixed port and no free port
  anywhere (the app's URL, the service's `ports`); with one it is
  `INVALID_CONFIG`.
- `e2e explore` and `e2e mcp` sessions start the services their target needs.

## Environment variables the runner reads

| Variable | Effect |
| --- | --- |
| `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, ... | Read by provider packages, not the runner. |
| `E2E_USER_<NAME>_USERNAME`, `E2E_USER_<NAME>_PASSWORD` | Override `credentials.<name>`; `<NAME>` is the name uppercased, other characters `_`. |
| `E2E_SECRET_<NAME>` | Overrides `secrets.<name>`, same rule. |
| `CI` | CI defaults; list in topic `running`. |
| `E2E_TELEMETRY_DISABLED`, `DO_NOT_TRACK` | Disable anonymous telemetry, as does `e2e telemetry disable`; `E2E_TELEMETRY_DEBUG=1` prints events instead of sending. |

## Mobile targets

`@e2e-dev/mobile` drives iOS simulators and Android emulators through
[agent-device](https://github.com/callstack/agent-device); needs Xcode with a
simulator runtime or the Android SDK with an emulator; run
`npx agent-device doctor` once.

```ts
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { mobileTools } from '@e2e-dev/mobile/tools';
import { gateway } from 'ai';

const iphone = mobile({ platform: 'ios' });

export default {
  targets: [{ engine: iphone, app: { bundleId: 'com.example.app' } }],
  workers: 1,
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      tools: mobileTools(iphone),
    },
  },
} satisfies E2EConfig;
```

- `app.bundleId`: bundle id, package name, or display name `app.open()`
  launches fresh (an attempt launches nothing itself; without it, the
  installed build). `app.appPath`: the `.app` or `.apk` under test; the
  engine installs nothing, so a fixture every test takes calls
  `device.installApp()` once per device (no path installs `app.appPath`).
  `app.launchArguments` and `app.permissions` ride every fresh launch:
  arguments reach the app process (iOS) or `am start` (Android), permissions
  are set first.
- One worker per device. No `device`: every booted simulator or emulator of
  the platform is the pool, up to `workers` (none booted: agent-device boots
  one); one `device`: one worker whatever `workers` says; a list (`device:
  ['iPhone 17', 'iPhone 17 Pro']`): an explicit pool. Devices boot in
  `prepare`, before the run's clock. Two sessions on one device fight over
  it: for parallel MCP sessions or bug-bash explorers, declare one target per
  device, each naming its `device`.
- `device` can be a `DeviceProvider` leasing hosted devices, one per worker
  slot: `easSimulators({ buildId })` from `@e2e-dev/eas` takes the project
  from the app config's `extra.eas.projectId` (`projectId` overrides), reads
  `EXPO_TOKEN`, else the `eas login` session, needs no Xcode or Android SDK, and with `buildId` EAS installs
  the app (omit `app.appPath`). A run must fit one session: `maxDurationMinutes`,
  absent, is the account's cap (40 on a standard plan). `videoTouches: false`
  on the engine for video there.
- Only a control that appeared or moved with the previous action waits out
  `transition` (default 500 ms); agent actions settle `settle` ms (default
  150) before the next observation, `settle: false` skips it.
- `screen`, `expect`, `app`, `agent` work unchanged; `test` from
  `@e2e-dev/mobile` types the `device` fixture (`installApp`, `openLink`,
  `setPermission`, `setNetwork`, `setAppearance`, `clearKeychain`, `fold`
  for an iPhone Duo's hinge, `locator`, more). Portable suites declare
  `requires: ['device']`.
- No `state` capability: `test.setup` and `session` are unavailable; sign in
  per test with `screen` actions or `agent.act`, both fill a `Secret` (topic
  `writing-tests`, Sign-in sessions).
- A deterministic check naming a platform label runs there only:
  `test('...', { platforms: ['ios'] }, ...)`.
- `selectOption`, `setInputFiles`, `scrollIntoView`, `secondaryTap`, and
  `modifiers` on `tap` or `doubleTap` are `UNSUPPORTED_CAPABILITY` on a
  device.
- React Native on iOS: checkbox and radio role and state come off the
  accessibility value (`getByRole`, `check()`, `toBeChecked` work); a tab is
  `other` with `selected`, query by test id or label; a plain `View` is a
  leaf, scope to the `ScrollView` or give children test ids.

## Done when

- `npx e2e run tests/example.e2e.ts` passes against the app.
- `package.json` has a script such as `"test:e2e": "e2e run"`.
- `.gitignore` lists the `.e2e/` outputs (init adds them); drop the
  `.e2e/cache/` line to commit replays.
- CI runs the whole suite, agent steps included, on PRs; see `running`.
