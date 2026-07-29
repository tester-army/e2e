# @e2edev/testbed

Dogfood workspace for the [`e2e`](../e2e) runner: a real project consuming the
`e2e` package exactly like a user would, with a growing suite of deterministic
tests.

## Layout

- `app/server.mjs` — dependency-free playground app (todos, login/session,
  forms, wizard, network, dialogs, iframes, downloads). The runner starts and
  stops it via `app.command`.
- `e2e.config.ts` — local config used by `pnpm test`.
- `tests/` — the local suite: queries, actions, polling assertions, sessions
  (`test.setup` + `session:`), serial groups, routes, dialogs, frames,
  downloads, keyboard input, credentials/secrets.
- `e2e.public.config.ts` + `tests-public/` — opt-in suite against real public
  websites (example.com, iana.org, playwright.dev), dogfooding the production
  opt-in and multi-origin policy.
- `e2e.agent.config.ts` + `tests-agent/` — opt-in agentic suite against the same
  playground: located actions, assisted polling, judgments, schema-validated
  extraction with zod, host-side secret fills, and mixed agentic/deterministic
  flows in a serial group.
- `e2e.mobile.config.ts` + `tests-mobile/` — opt-in `mobile-0.1` suite driving
  the built-in iOS Settings app through `e2e/agent-device`, so it needs no app
  build of its own.

## Commands

```bash
pnpm --filter e2e build            # the testbed runs the built runner
pnpm --filter @e2edev/testbed test    # typecheck + local suite (starts the app itself)
pnpm --filter @e2edev/testbed test:headed
pnpm --filter @e2edev/testbed test:public   # real websites, not in CI
pnpm --filter @e2edev/testbed test:mobile   # iOS simulator, not in CI
E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent   # real model calls, not in CI
pnpm --filter @e2edev/testbed app     # run the playground manually
```

The local suite runs in CI on every push. Reports land in `.e2e/report.json`;
artifacts under `.e2e/artifacts/`.

## Agentic suite

`test:agent` spends real model calls, so it is opt-in and never runs in CI. It
pins `google/gemini-3-flash` and honours `E2E_MODEL` so the same suite can be
replayed across providers:

```bash
E2E_MODEL_API_KEY=...  pnpm --filter @e2edev/testbed test:agent
E2E_MODEL=openai/gpt-5.4-mini E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent
```

Agentic assertions are structurally comparable across models, not textually
identical, so these tests assert on meaning (`toContain`) and pair every
agentic step with a deterministic locator check.

## Mobile suite

`test:mobile` drives the built-in iOS **Settings** app, so there is nothing to
build first. It is opt-in and never runs in CI: it needs macOS, Xcode, and a
simulator, and the first run builds the XCTest runner that `agent-device` uses
for snapshots.

```bash
pnpm --filter e2e build
pnpm --filter @e2e/testbed test:mobile
E2E_IOS_DEVICE="iPhone 17 Pro" pnpm --filter @e2e/testbed test:mobile
```

Three things about the config are load-bearing, and they are the shape any
mobile project ends up with:

- **No `app` URL.** `mobile-0.1` has no base URL; app identity is the target's
  `app`, a bundle id here and a `.app`/`.ipa`/`.apk`/`.aab` path for a real build.
- **`workers: 1`.** Parallelism is one device per worker. A second worker would
  only contend for the single configured simulator and be rejected.
- **`reset: 'relaunch'`.** Settings is a built-in app with no data container, so
  it cannot be state-cleared between attempts. Relaunching still returns it to
  the root list, which is what makes each test start from a known screen. A
  normal app keeps the default `clear-state` isolation.

Expect roughly 3-8 s per test: every locator resolve is an XCTest accessibility
snapshot, which is orders of magnitude slower than a browser query.

## Mobile agentic suite

`test:mobile-agent` points the agent tier at the same Settings app. It is
opt-in twice over: it needs a simulator *and* spends real model calls.

```bash
OPENAI_API_KEY=... pnpm --filter @e2e/testbed test:mobile-agent
E2E_MODEL=gpt-5.6-luna OPENAI_API_KEY=... pnpm --filter @e2e/testbed test:mobile-agent
```

It passes a provider instance rather than a gateway model reference, so a plain
`OPENAI_API_KEY` is enough; the web agentic suite uses the gateway form instead.

The agent tier consumes `observe()` and the driver's action surface rather than
the locator engine, so it is the only place mobile observation quality shows up.
A Settings root screen serializes to roughly 1.8 KB: layout wrappers that only
repeat a descendant's label are collapsed out of the observation, which is what
keeps a mobile tree affordable to send.
