# @e2edev/testbed

Dogfood workspace for the [`e2e`](../e2e) runner: a real project consuming the
`e2e` package exactly like a user would, with a growing suite of deterministic
tests.

## Layout

- `app/server.mjs` — dependency-free playground app (todos, login/session,
  forms, wizard, network, dialogs, iframes, downloads). The runner starts and
  stops it via the playwright engine's `command` option.
- `e2e.config.ts` — local config used by `pnpm test`.
- `tests/` — the local suite: queries, actions, polling assertions, sessions
  (`test.setup` + `session:`), serial groups, routes, dialogs, frames,
  downloads, keyboard input, credentials/secrets.
- `e2e.public.config.ts` + `tests-public/` — opt-in suite against real public
  websites (example.com, iana.org, playwright.dev), dogfooding the production
  opt-in and multi-origin policy.
- `e2e.agent.config.ts` + `tests-agent/` — opt-in agentic suite against the same
  playground: `agent.act` flows, assisted polling, judgments, and
  schema-validated extraction with zod.
- `e2e.device.config.ts` + `tests-device/` — opt-in mobile suite on the
  `@e2edev/agent-device` engine, two targets: an iOS simulator and an Android
  emulator, each with its Settings app. Portable files (`about`, `device`) run
  on both unchanged; `ios` and `android` hold the label-bound deterministic
  checks. Needs a booted simulator, one AVD, and a model credential; steps
  replay from the trace cache on a second run. See "Device suite" below.
- `e2e.reminders.config.ts` + `tests-reminders/` — opt-in iOS stress suite:
  long agentic sessions in the Reminders app (batch entry through the focused
  field, completion, swipe-to-delete, list management, an interruption), each
  claim paired with a deterministic tree check. See "Device suite" below.
- `e2e.selenium.config.ts` + `tests-selenium/` — opt-in suite against
  seleniumbase.io, the community practice site. Deliberately adversarial
  surfaces: shadow roots, frames written into `about:blank`, nested frames,
  HTML5 drag-and-drop, canvas, native dialogs, TinyMCE, an anti-bot page, and
  pages whose controls have no accessible name. See "Known gaps" below.

## Commands

```bash
pnpm --filter @e2edev/e2e build            # the testbed runs the built runner
pnpm --filter @e2edev/testbed test    # typecheck + local suite (starts the app itself)
pnpm --filter @e2edev/testbed test:headed
pnpm --filter @e2edev/testbed test:public   # real websites, not in CI
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

To see where the tokens went, record the run and open the trace in
[unbox-ai](https://github.com/tester-army/unbox-ai):

```bash
E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent -- --ai-trace
npx unbox-ai .e2e/ai-trace.json          # viewer: treemap, waterfall, diffed turns
npx unbox-ai runs .e2e/ai-trace.json     # one line per agent step, from the terminal
```

To watch calls land while the suite runs, `e2e.agent.config.ts` registers the
AI SDK devtools recorder when `E2E_DEVTOOLS` is set; start the live viewer
first, in this directory:

```bash
npx unbox-ai devtools                    # live viewer on http://localhost:4983
E2E_DEVTOOLS=1 E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent -- --workers 1
```

The devtools recorder names runs after their first prompt and keeps one
database per process, hence `--workers 1`; the `--ai-trace` file names runs
after the test and step and merges every worker, so use it for anything you
want to keep or compare.

## Device suite

`test:device` runs against a real iOS simulator with real model calls, so it is
opt-in and never runs in CI. It needs Xcode with a booted simulator (check with
`npx agent-device doctor`) and pins `openai/gpt-5.6-luna`; `E2E_MODEL`
overrides it. Run one device suite at a time: workers share the pinned
agent-device session.

```bash
AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:device      # Settings: grammar, screen tier, device fixture
AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:reminders   # Reminders: long agentic stress sessions
```

Each engine opens its platform's Settings app fresh before every test, so no
step needs an agent-side tool to get started and every `agent.act` step stays
inside the grammar. The portable tests describe goals, not labels ("open the
screen that describes this device"), and read the result back with judgments
or `agent.extract`; that is what lets one file run on both targets. The first run records a trace per passing step; the second run
replays them with zero model calls (`step.cache.mode` is `self-finalized` in
`.e2e/report.json`). Judgments still spend a call each.

## Known gaps (seleniumbase.io suite)

The suite is opt-in and never runs in CI:

```bash
pnpm --filter @e2edev/testbed test:selenium    # 55 pass, 4 skip
```

Every remaining `skip` is a pinned finding, not a flake, and names its cause at
the call site.

### Open gaps

1. **`Screen` has no `locator`.** `web.frameLocator` returns a `Screen`, which
   exposes only the six `getBy*` queries, so inside a frame a control with no
   accessible name is unaddressable and a second frame boundary is
   inexpressible. Costs three deterministic tests (`skip`) and forces
   `web.evaluate` for the nested document. The locator AST already supports
   `frame` + `web-selector`; only the public surface is missing.
2. **No secondary pointer button.** The coffee cart's right-click `<dialog>`
   cannot be opened at all (`skip`).
3. **No page-level response/console feed.** "loaded with no 404s and no JS
   errors" is reconstructed from `web.route` on the request side.
4. **`Role` is a closed 15-member union.** No `radio`, `combobox`, `option`,
   `tabpanel`, so radio groups and selects need `web.locator`.
5. **The reference engine is detected by anti-bot.** `/hobbit/login` redirects to
   a block page on load; the aspirational test is `skip`ped and the block pinned.

### Closed

- **Open shadow roots are observed.** The walk descends into `shadowRoot`, so a
  control that exists only in a shadow tree is selectable.
- **Empty painted rectangles are observed** with the role `box`, so a drop zone
  or a swatch can be named at all. An unpainted spacer of the same size stays
  out: a person cannot see it either.

### Hazards worth knowing, neither an SDK defect

- `fill` on a rich-text host resolves successfully and changes nothing (TinyMCE
  reverts it) — a silent no-op only a paired deterministic assertion catches.
- `instanceof` across a frame boundary is always false: an element inside an
  iframe belongs to that frame's realm, so `field instanceof HTMLInputElement`
  in a `web.evaluate` silently takes the else branch.
- Agentic assertions must be answerable from one observation. "the canvas asks
  whether you are hungry *again*" is correctly refused: a screenshot cannot show
  recurrence. Assert state, not history.
- String text matching is **exact by default**, inverting the Playwright and
  Testing-Library default.
