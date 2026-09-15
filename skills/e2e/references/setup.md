# Setting up e2e

## Requirements

- Node.js 22.12 or newer.
- ES modules. e2e loads `.ts` config, tests, and helpers as ES modules
  whatever the nearest `package.json` `type` says, so a CommonJS package (a
  Next.js app, for instance) needs no change. Write them with `import`, never
  `require` or `module.exports`.
- For browser tests, `@e2edev/playwright` plus `playwright` (`>=1.63.0 <2`),
  a peer dependency the engine does not install itself: an app that already
  depends on Playwright keeps its version and its browser cache. A version
  outside the range may be rejected by the package manager as an unmet peer
  (npm's `ERESOLVE`); upgrade `playwright` within the range.
  Missing browsers download when the engine first boots. In CI install them
  up front: `npx playwright install chromium --with-deps`.
- For mobile tests, `@e2edev/agent-device`. It installs the `agent-device`
  it was built and tested against, pinned exactly because agent-device minors
  break; the pin moves with each engine release.

## Scaffold

```bash
npx e2e@beta init       # npm
pnpm dlx e2e@beta init  # pnpm
```

When `e2e` is already installed, run `npx e2e init` instead, so the
installed version scaffolds.

The wizard asks for the engine (Web with Playwright by default; Mobile with
agent-device and None are the alternatives), which model gateway agent steps
use (adds AI SDK v7 and the provider package), which agent directories receive this skill
(`.agents/skills/` and `.claude/skills/`), a confirmation of the files it
will write, and whether to install. `--yes` skips every prompt (use it from
scripts and from a shell without a TTY): Playwright, the Vercel AI Gateway,
no installation, skill in both directories. The closing line prints the run
command through the project's package manager,
`APP_URL=http://localhost:3000 npm run test:e2e` for Playwright under npm, and
suggests a `tsconfig.json` when the project has none.

Init writes `package.json` (a private ESM package when missing; otherwise
only the missing dev dependencies and the `test:e2e` script are added),
`e2e.config.ts`, `tests/example.e2e.ts`, `.gitignore` entries for the `.e2e/`
output, and the skill. Existing config and test files are never touched. Re-run it after an
upgrade to refresh the skill; it changes nothing else in an initialized
project.

Without the wizard:

```bash
npm install --save-dev e2e@beta @e2edev/playwright@beta playwright ai@^7
```

`ai` (the Vercel AI SDK, v7) is only needed for `agent.*` steps.

## The config

`e2e.config.ts` sits at the project root and default-exports an object
literal ending in `satisfies E2EConfig`. The runner validates it at load:
unknown keys are `INVALID_CONFIG`.

```ts
import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { playwright } from '@e2edev/playwright';
import { gateway } from 'ai';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      engine: playwright({
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], log: '.e2e/logs/app.log' },
      }),
    },
  ],
  // The model behind every agent.* step: an AI SDK instance; gateway() from 'ai' reads AI_GATEWAY_API_KEY.
  agents: {
    default: createAgent({
      model: gateway('openai/gpt-5.6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome on screen.',
    }),
  },
  credentials: {
    admin: { username: 'admin@example.test', password: process.env.ADMIN_PASSWORD ?? '' },
  },
} satisfies E2EConfig;
```

| Key | Default | Notes |
| --- | --- | --- |
| `targets` | required | Non-empty. Each target: `platform` (`web`, `ios`, `android`, or any label), `engine`, and an optional `name` (defaults to the platform; used by `--target` and in reports). |
| `tests` | `'tests/**/*.e2e.ts'` | A glob or an array of globs, `/` separators. |
| `timeout` | `120000` | Per test attempt, in ms. Also the default `agent.act` deadline. |
| `actionTimeout` | `30000` | Every locator action and engine operation, including each observation inside an agent step. Raise it for slow model providers. |
| `assertionTimeout` | `5000` | `expect` polling window. |
| `retries` | `0`, `1` in CI | 0 to 10. |
| `workers` | half the cores, `1` in CI | Test files run in parallel across workers, at most the `workers` the engine declares per target (a device target: one per device). |
| `reporters` | `['list']` | `list`, `json`, `junit`, `markdown`, and reporter objects (`{ name, onEvent?, onRunFinished? }`) that receive the finished run. `json` excludes `list`; `--reporter` keeps the objects. |
| `cache` | `'read-write'`, `'read-only'` in CI | The trace cache for `agent.act`; `'off'` disables it. |
| `agents` | `{ default: built-in }` | Agents by name. `default` is what tests run with; `e2e run --agent <name>` runs with another. Each entry is `createAgent(...)`, an options block `{ model, judge, context, maxSteps, maxModelCalls, providerOptions }`, or a custom `StepExecutor`. `model` is an AI SDK instance; without one anywhere, acquiring `agent` is `MODEL_UNAVAILABLE`. |
| `credentials` | `{}` | Named `{ username, password }` entries; `password` may be a function returning the value. |
| `secrets` | `{}` | Named values the model never sees (API keys, tokens): a string or a function returning the value. A name cannot also be a credential. |
| `artifacts` | `['screenshot', 'trace']` | Kinds to keep (`screenshot`, `trace`, and the opt-in `video`), or `{ kinds, store, video }`; `video: { retain: 'on-failure' }` keeps only the recordings of attempts that did not pass. |
| `projectId` | the package name | Report and cache identity. |

## The app under test

The engine declares the app; the runner owns navigation policy, the app
process, and identity. `playwright()` accepts:

| Option | Meaning |
| --- | --- |
| `url` | Base URL for `app.open()` and relative navigation. A missing scheme becomes `https://`, or `http://` for a loopback host. Required once a test navigates. Port `0` on `127.0.0.1` or `[::1]` asks the run for a free port. |
| `command` | The process that serves `url`. `{port}` in `args` and `env` expands to the port of `url`. See below. |
| `readyUrl` | Readiness probe when it differs from `url`. `{port}` expands here too. |
| `services` | Dependency processes started before `command`, in order. |
| `environment` | `'test'`, `'staging'`, `'production'`. Inferred from the host; a label for the report and the cache key. |
| `identity` | Stable app identity for cache and session keys when the origin changes per deploy (preview URLs). |
| `browser` | `'chromium'` (default), `'firefox'`, `'webkit'`. |
| `viewport` | `{ width, height }`, default 1280x720. |
| `connect` | `{ cdpEndpoint }` attaches to a remote Chromium over CDP. Adding `reconnectEndpoint` uses a dedicated persistent default context, provisions a fresh browser per attempt, and reconnects only to the original browser and page. |
| `headers` | Request headers sent to the app's site only (a Vercel `x-vercel-protection-bypass`, ngrok's `ngrok-skip-browser-warning`). Reaches every path onto the page, `agent.act` included; turns the browser HTTP cache off and blocks service workers. |
| `basicAuth` | `{ username, password }` answering a `401` challenge. |

CDP recovery never repeats a dispatched operation. Endpoint resolution, attachment,
and dispatch spend one operation budget. Exhaustion raises `OPERATION_TIMEOUT`;
caller cancellation raises `CANCELLED`. A read started before recovery cannot
satisfy its requirement for a fresh observation. The host owns remote browser
cleanup. Persistent recovery requires the default context's CDP identity.
If navigation while disconnected loses a frame's closed shadow DOM tracking
hook, recovery fails with `ENGINE_FAILURE`; the engine cannot prove pixel
masking for existing closed roots in that document.
Observation-derived `tapAt` calls, observation-root swipes, and focused engine
keyboard input need a fresh engine observation after reconnect. Deterministic
`web.mouse` and `web.keyboard` calls use test-supplied input without an agent
observation; test code can read current geometry and focus with `web.evaluate`.
Persistent recovery does not support `headers`, `basicAuth`, context reset,
or session state capture and restore. Without `reconnectEndpoint`, contexts
remain isolated and a dropped connection is reacquired only at the next attempt
start.

Two browsers are two targets sharing one app declaration:

```ts
const app = { url: 'http://127.0.0.1:3000' };
export default {
  targets: [
    { name: 'chromium', engine: playwright(app) },
    { name: 'mobile-webkit', engine: playwright({ ...app, browser: 'webkit', viewport: { width: 390, height: 844 } }) },
  ],
} satisfies E2EConfig;
```

### Let the runner start the app

Prefer `command` over a hand-started dev server: the run is then
self-contained locally and in CI.

```ts
engine: playwright({
  url: 'http://127.0.0.1:3000',
  services: [
    {
      name: 'postgres',
      executable: 'docker',
      args: ['compose', 'up', '--wait', 'postgres'],
      waitForExit: true,
      teardown: { executable: 'docker', args: ['compose', 'down'] },
    },
    { name: 'migrate', executable: 'pnpm', args: ['db:migrate'], waitForExit: true },
  ],
  command: {
    executable: 'pnpm',
    args: ['dev'],
    env: { PORT: '3000', DATABASE_URL: process.env.DATABASE_URL ?? '' },
    startupTimeout: 120_000,
    log: '.e2e/logs/app.log',
  },
}),
```

How it behaves:

- The runner spawns `command`, polls `readyUrl` (default `url`) until a
  200 to 499 status arrives within `startupTimeout` (default 60 s), and stops
  the process when the run ends, fails, or is interrupted. Never ready is
  `APP_UNREACHABLE`; `.e2e/report.json` is still written.
- The child inherits only `PATH`, `HOME`, and the temp-directory variables,
  plus `command.env`. Anything the app needs (database URL, API keys) must be
  passed through `env` explicitly. Model keys and `E2E_USER_*` values are
  never inherited.
- Output is discarded unless `log` names a file. Set it; a server that dies
  on boot is otherwise invisible. Keep the file under an ignored directory
  such as `.e2e/logs/`.
- If `url` already answers before the spawn, the run fails with
  `APP_ALREADY_RUNNING`. Set `reuseExisting: true` for local development to
  attach to a dev server that is already up; CI ignores the flag.
- `services` start one at a time in declaration order. Each declares
  `readyUrl` (polled) or `waitForExit: true` (ready when it exits 0). On
  every exit path the runner stops the app, stops the services in reverse,
  then runs their `teardown` commands in reverse.
- `executable` is resolved on `PATH` and never shell-interpreted. Point it at
  the server itself rather than at a wrapper script.
- `url: 'http://127.0.0.1:0'` (or `[::1]:0`, never `localhost:0`) asks the
  run for a free port, so two checkouts can run at once. The command must take
  it through `{port}` in `args` or `env`; the token also expands in `readyUrl`
  and the services:
  `command: { executable: 'pnpm', args: ['dev', '--port', '{port}'], env: { PORT: '{port}' } }`.
  Tests read the allocated URL from `app.baseUrl`; the cache identity keeps
  the declared `:0`. Services keep their own ports. A port another process
  grabs between allocation and spawn fails the start with `APP_UNREACHABLE`;
  rerun.

To test an app started elsewhere, point `url` at it and start it yourself,
or read the address from the environment:
`url: process.env.APP_URL ?? 'http://localhost:3000'`. The runner reads no
`APP_URL` itself; the config does.

## Environment variables the runner reads

| Variable | Effect |
| --- | --- |
| `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, ... | Read by the provider package the config constructs the model with (`gateway()` from `ai`, `openrouter()`, `openai()`), not by the runner. The runner reads no model variable; the model is always an AI SDK instance in the config. |
| `E2E_USER_<NAME>_USERNAME`, `E2E_USER_<NAME>_PASSWORD` | Override `credentials.<name>`. `<NAME>` is the credential name uppercased, other characters as `_`. |
| `E2E_SECRET_<NAME>` | Overrides the value of `secrets.<name>`, same uppercasing rule. |
| `CI` | Turns on CI defaults: `retries: 1`, `workers: 1`, `test.only` rejected, cache read-only, `reuseExisting` ignored. |
| `E2E_TELEMETRY_DISABLED`, `DO_NOT_TRACK` | Turn anonymous usage telemetry off; `e2e telemetry disable` saves the same choice. `E2E_TELEMETRY_DEBUG=1` prints each event instead of sending it. |

## Mobile targets

`@e2edev/agent-device` drives iOS simulators and Android emulators through
[agent-device](https://github.com/callstack/agent-device). It needs Xcode
with a simulator runtime, or the Android SDK with an emulator; run
`npx agent-device doctor` once.

```ts
import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { agentDevice } from '@e2edev/agent-device';
import { agentDeviceTools } from '@e2edev/agent-device/tools';

const iphone = agentDevice({ platform: 'ios', app: 'com.example.app' });

export default {
  targets: [{ engine: iphone }],
  workers: 1,
  agents: { default: createAgent({ tools: agentDeviceTools(iphone) }) },
} satisfies E2EConfig;
```

- `app` is a bundle id, package name, or display name opened fresh per
  attempt. `appPath` installs a `.app` or `.apk` once per worker; without
  `app`, the installed bundle is the one opened.
- One worker per device. With no `device`, every booted simulator or
  emulator of the platform is the pool, as many as `workers` allows, so
  booting four simulators runs the files four at a time with no config. A
  single `device` runs one worker whatever `workers` says; a list,
  `device: ['iPhone 17', 'iPhone 17 Pro']`, is an explicit pool. Devices boot
  in `prepare`, before the run's clock starts.
- A test's steps never wait for the screen to settle; `expect` verifies the
  outcome. Only a control that appeared or moved with the previous action
  waits out the `transition` budget (default 500 ms) before it is acted on.
  Agent actions settle for `settle` ms (default 150) before the agent
  observes again; `settle: false` skips that wait.
- Cancelled device commands keep running; the next attempt waits for them.
  Raw screenshot files are removed when capture finishes, including after
  cancellation.
- `screen`, `expect`, `app`, and `agent` work unchanged. Import `test` from
  `@e2edev/agent-device` to type the `device` fixture (`setAppearance`,
  `setNetwork`, `setPermission`, `installApp`, `locator('role=... id=...')`,
  and more). Portable suites declare `requires: ['device']`.
- No `state` capability: `test.setup` and `session` are unavailable on a
  device. Sign in with deterministic `screen` actions; `agent.act` cannot
  fill a `Secret` on a device.
- A deterministic check that names a platform label runs on one platform
  only: `test('...', { platforms: ['ios'] }, ...)`.
- `selectOption`, `setInputFiles`, and `scrollIntoView` are
  `UNSUPPORTED_CAPABILITY` on a device.

## Done when

- `npx e2e run tests/example.e2e.ts` passes against the app.
- `package.json` has a script such as `"test:e2e": "e2e run"`.
- `.gitignore` lists the `.e2e/` outputs (init adds them). Committing
  `.e2e/cache/` is opt-in: remove that line so CI and teammates replay
  `agent.act` steps instead of re-running the model.
- CI runs the whole suite on pull requests, agent steps included; see
  `running`.
