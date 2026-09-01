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
  playground: `agent.act` flows, assisted polling, judgments, and
  schema-validated extraction with zod.
- `e2e.selenium.config.ts` + `tests-selenium/` — opt-in suite against
  seleniumbase.io, the community practice site. Deliberately adversarial
  surfaces: shadow roots, frames written into `about:blank`, nested frames,
  HTML5 drag-and-drop, canvas, native dialogs, TinyMCE, an anti-bot page, and
  pages whose controls have no accessible name. See "Known gaps" below.

## Commands

```bash
pnpm --filter e2e build            # the testbed runs the built runner
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
2. **`getAttribute` reads a whitelist**, returning `null` for `readonly`,
   `draggable`, `class`, `src` — indistinguishable from absent. There is no
   `toHaveAttribute`/`toHaveClass` either, so attribute checks fall to
   `web.evaluate`.
3. **No secondary pointer button.** The coffee cart's right-click `<dialog>`
   cannot be opened at all (`skip`).
4. **No page-level response/console feed.** "loaded with no 404s and no JS
   errors" is reconstructed from `web.route` on the request side.
5. **`Role` is a closed 15-member union.** No `radio`, `combobox`, `option`,
   `tabpanel`, so radio groups and selects need `web.locator`.
6. **The reference driver is detected by anti-bot.** `/hobbit/login` redirects to
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
- String text matching is **exact by default** (`spec/03-assertions.md:36`),
  inverting the Playwright and Testing-Library default.
