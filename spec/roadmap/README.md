# Roadmap

Deferred designs. Not part of the v0 spec, not in `api.d.ts` — the core
must ship and win first. Designs here are drafts kept for when their time
comes; they will be re-validated against the then-current core API before
adoption.

| Item | Design | Summary |
|---|---|---|
| Service emulation | [service-emulation.md](./service-emulation.md) | Local, stateful Stripe/Slack/email emulators as a `services` fixture with first-class assertions (`expect(stripe).toHavePayment(…)`); managed sandboxes in Cloud |
| PR testing | [pr-testing.md](./pr-testing.md) | `pr.context()`, preview-URL resolution, changed-file test selection, exploratory `test.dynamic`, automatic GitHub Checks |
| Phone/SMS resources | (shape reserved in api.d.ts) | `phone.number()` with SMS/OTP extraction — Cloud-first |
| Visual snapshots | — | `toMatchScreenshot` pixel diffing, complementing `agent.assert` semantic judgment |
| Network interception | — | cross-platform request routing, if it earns its place over service emulation |

(The driver SPI is **not** roadmap — it's core, see
[09-drivers.md](../09-drivers.md): community backends are a founding goal.)

## Why deferred

The core bet is narrow and deep: **cross-platform agentic testing** —
`test()`, the agent tiers, `screen`, resources, sessions, targets. Nothing
above is required to prove that bet; everything above gets stronger once the
core is adopted.
