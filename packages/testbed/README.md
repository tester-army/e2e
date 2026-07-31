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
- `e2e.selenium.config.ts` + `tests-selenium/` and
  `e2e.selenium-agent.config.ts` + `tests-selenium-agent/` — opt-in suites
  against seleniumbase.io, the community practice site. Deliberately adversarial
  surfaces: shadow roots, frames written into `about:blank`, nested frames,
  HTML5 drag-and-drop, canvas, native dialogs, TinyMCE, an anti-bot page, and
  pages whose controls have no accessible name. The two configs drive the same
  pages deterministically and agentically so a gap in one tier is
  distinguishable from a gap in the other. See "Known gaps" below.

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

## Known gaps (seleniumbase.io suites)

Both suites are opt-in and never run in CI:

```bash
pnpm --filter @e2edev/testbed test:selenium                                # 55 pass, 4 skip
E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:selenium-agent    # 25 pass, 2 skip
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
2. **`dragTo` cannot hold two reference-only endpoints.** It locates twice, each
   locate takes two observations, and every observation disposes the generation
   before it — so the source handle is gone by dispatch. A drag with one
   query-addressable endpoint works; a page that gives neither does not (`skip`,
   agentic drag inside a frame). Retaining generations is a driver lifecycle
   decision, deliberately left for its own change.
3. **`data:` frames are outside the agent's view by contract.** `spec/14-security.md`
   denies the scheme by name, so an inline frame stays a boundary node however it
   got there. Admitting it for observation only — it has an opaque origin, and its
   bytes come from a document that was already admitted — is a spec change with
   its own review, not something an observation walk decides (`skip`, agentic
   checkbox inside an embedded document).
4. **`getAttribute` reads a whitelist**, returning `null` for `readonly`,
   `draggable`, `class`, `src` — indistinguishable from absent. There is no
   `toHaveAttribute`/`toHaveClass` either, so attribute checks fall to
   `web.evaluate`.
5. **No secondary pointer button.** The coffee cart's right-click `<dialog>`
   cannot be opened at all (`skip`).
6. **No page-level response/console feed.** "loaded with no 404s and no JS
   errors" is reconstructed from `web.route` on the request side.
7. **`Role` is a closed 15-member union.** No `radio`, `combobox`, `option`,
   `tabpanel`, so radio groups and selects need `web.locator`.
8. **The reference driver is detected by anti-bot.** `/hobbit/login` redirects to
   a block page on load; the aspirational test is `skip`ped and the block pinned.
9. **Agent steps record no resolved locator.** A step that resolves the *wrong*
   node still reports `passed`; only the paired deterministic assertion catches
   it. `E2E_DEBUG=agent` shows the selection, the report does not.

### Closed

- **Unnamed controls are reachable.** `deriveQueries` returning nothing used to
  throw before the reference and selector paths could run, so the agent tier
  failed hardest on exactly the controls that have no deterministic address
  either. It now falls through, and a node with an anchored platform selector
  becomes a first-class located node (`locate.selector`) rather than
  reference-only. Covered by `packages/e2e/tests/integration/agent-unnamed.test.ts`.
- **Open shadow roots are observed.** The walk descends into `shadowRoot`, so a
  control that exists only in a shadow tree is selectable.
- **Empty painted rectangles are observed** with the role `box`, so a drop zone
  or a swatch can be named at all. An unpainted spacer of the same size stays
  out: a person cannot see it either.
- **A drag can end on a reference-only node.** The pointer path accepts an
  element handle, which `Locator.dragTo` cannot.

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
