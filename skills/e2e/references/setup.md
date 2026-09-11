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

## Scaffold

```bash
npx @e2edev/e2e@beta init       # npm
pnpm dlx @e2edev/e2e@beta init  # pnpm
```

When `@e2edev/e2e` is already installed, run `npx --no-install e2e init`
instead, so the installed version scaffolds.

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

### Where the suite lives

In a monorepo the suite belongs in the app's own package: run
`e2e init apps/web` from the workspace root, or `cd` into the app first, so
`e2e.config.ts` and `tests/` sit beside the app's `package.json`, the runner
and engine join its `devDependencies`, and support code imports the app's
modules the ordinary way. Only when the app is not a Node package, or the
suite needs different major versions of shared dependencies, make a separate
package, and then a workspace member covered by the root workspace globs (a
`packages/*` entry, for example), never a nested
install root with its own lockfile: that costs relative-path imports into the
app's `node_modules`, a second lockfile, and root scripts that skip the suite.
`init` warns when the directory matches none of the workspace's globs.

Without the wizard:

```bash
npm install --save-dev @e2edev/e2e@beta @e2edev/playwright@beta playwright ai@^7
```

`ai` (the Vercel AI SDK, v7) is only needed for `agent.*` steps.

## The config

`e2e.config.ts` sits at the project root and default-exports an object
literal ending in `satisfies E2EConfig`. The runner validates it at load:
unknown keys are `INVALID_CONFIG`.

```ts
import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
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
  // Only for agent.* steps. The model is an AI SDK instance; gateway() from 'ai' reads AI_GATEWAY_API_KEY.
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
| `reporters` | `['list']` | `list`, `json`, `junit`, and reporter objects (`{ name, onEvent?, onRunFinished? }`) that receive the finished run. `json` excludes `list`; `--reporter` keeps the objects. |
| `cache` | `'read-write'`, `'read-only'` in CI | The trace cache for `agent.act`; `'off'` disables it. |
| `agents` | `{ default: built-in }` | Agents by name. `default` is what tests run with; `e2e run --agent <name>` runs with another. Each entry is `createAgent(...)`, an options block `{ model, context, maxSteps, maxModelCalls, vision, providerOptions }`, or a custom `StepExecutor`. `model` is an AI SDK instance; without one anywhere, acquiring `agent` is `MODEL_UNAVAILABLE`. |
| `credentials` | `{}` | Named `{ username, password, allowedOrigins? }` entries; `password` may be a function returning the value. |
| `screen.testIdAttribute` | `'data-testid'` | Attribute read by `getByTestId`. |
| `artifacts` | `['screenshot', 'trace']` | Kinds to keep (`screenshot`, `trace`, and the opt-in `video`), or `{ kinds, store, video }`; `video: { retain: 'on-failure' }` keeps only the recordings of attempts that did not pass. |
| `projectId` | the package name | Report and cache identity. |

## The app under test

The engine declares the app; the runner owns navigation policy, the app
process, and identity. `playwright()` accepts:

| Option | Meaning |
| --- | --- |
| `url` | Base URL for `app.open()` and relative navigation. A missing scheme becomes `https://`, or `http://` for a loopback host. Required once a test navigates. |
| `command` | The process that serves `url`. See below. |
| `readyUrl` | Readiness probe when it differs from `url`. |
| `services` | Dependency processes started before `command`, in order. |
| `allowedOrigins` | Origins tests and the agent may navigate to. Default: the origin of `url`. |
| `environment` | `'test'`, `'staging'`, `'production'`. Inferred from the host; a label for the report and the cache key. |
| `identity` | Stable app identity for cache and session keys when the origin changes per deploy (preview URLs). |
| `browser` | `'chromium'` (default), `'firefox'`, `'webkit'`. |
| `viewport` | `{ width, height }`, default 1280x720. |
| `connect` | `{ cdpEndpoint }` to attach to a remote Chromium over CDP instead of launching. |
| `headers` | Request headers sent to allowed origins only (a Vercel `x-vercel-protection-bypass`, ngrok's `ngrok-skip-browser-warning`). Reaches every path onto the page, `agent.act` included; turns the browser HTTP cache off and blocks service workers. |
| `basicAuth` | `{ username, password }` answering a `401` challenge from an allowed origin; never sent to any other. |

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

To test an app started elsewhere, point `url` at it and start it yourself,
or read the address from the environment:
`url: process.env.APP_URL ?? 'http://localhost:3000'`. The runner reads no
`APP_URL` itself; the config does.

## Environment variables the runner reads

| Variable | Effect |
| --- | --- |
| `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, ... | Read by the provider package the config constructs the model with (`gateway()` from `ai`, `openrouter()`, `openai()`), not by the runner. The runner reads no model variable; the model is always an AI SDK instance in the config. |
| `E2E_USER_<NAME>_USERNAME`, `E2E_USER_<NAME>_PASSWORD` | Override `credentials.<name>`. `<NAME>` is the credential name uppercased, other characters as `_`. |
| `CI` | Turns on CI defaults: `retries: 1`, `workers: 1`, `test.only` rejected, cache read-only, `reuseExisting` ignored. |
| `E2E_TELEMETRY_DISABLED`, `DO_NOT_TRACK` | Turn anonymous usage telemetry off; `e2e telemetry disable` saves the same choice. `E2E_TELEMETRY_DEBUG=1` prints each event instead of sending it. |

## Mobile targets

`@e2edev/agent-device` drives iOS simulators and Android emulators through
[agent-device](https://github.com/callstack/agent-device). It needs Xcode
with a simulator runtime, or the Android SDK with an emulator; run
`npx agent-device doctor` once.

```ts
import type { E2EConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
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

- `npx --no-install e2e run tests/example.e2e.ts` passes against the app.
- `package.json` has a script such as `"test:e2e": "e2e run"`.
- `.gitignore` lists the `.e2e/` outputs (init adds them). Committing
  `.e2e/cache/` is opt-in: remove that line to share `agent.act` replays.
- CI runs the deterministic suite on pull requests; see `running`.
