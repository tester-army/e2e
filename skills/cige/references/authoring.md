# Writing a CIGE case

A case keeps what a test proves apart from how it gets there. Write Intent
so it would still be true if every button moved; write Execution as the
path that works today.

## Contents

- Ask before you write
- The file
- Where each thing goes
- Dimensions
- Refs
- The config
- Extending
- Before you hand a new case over

## Ask before you write

A failure can only be classified against ground truth, and a repair can
only be proven in an environment that resets. Get both before the first
case, not at the first failure.

**One time per project**, when there is no `cige.config.ts` yet, find
these in the repository first, then ask the user for what you can't find.
Ask in one message, and write the answers into `cige.config.ts`:

1. Where is the spec or requirements for a flow? (A docs folder, a wiki
   space, a ticket system.) This becomes `specRef` on each case, or a
   `refs.spec` resolver.
2. Where are the release notes or changelog for a build, and what
   identifies a build in CI (a commit SHA, a release tag)? This becomes
   `build` (for example `process.env.GITHUB_SHA`) and `buildRef` or a
   `refs.build` resolver.
3. Does a build have expected output to compare with, such as mocks,
   fixtures, or golden files? Where do they live per build? This becomes
   `expectedRef` or a `refs.expected` resolver.
4. Which environments do the tests run in, which e2e config reaches each,
   and how is each reset to a known state (a seed script, a reset
   endpoint)? This becomes `environments` with `config` and `reset`.

A resolver may call a wiki, a release API, or a file; it runs only when an
agent asks for the refs. If the user has no answer for one, record that in
the config as a comment and go on; `e2e-cige check` keeps reporting it.

**Per case**, before writing Execution: if you can't find the spec section
for this flow, or the case needs expected output you can't locate, ask for
that one pointer. Don't invent a path.

## The file

```json
{
  "$schema": "../../node_modules/@e2e-dev/cige/schema/cige-1.schema.json",
  "id": "checkout-discount",
  "Context": {
    "system": "Shop web app",
    "environment": "staging",
    "actor": "a signed-in shopper",
    "open": "/cart",
    "preconditions": [{ "hook": "seedCart", "description": "The cart holds two of ITEM-100" }],
    "specRef": "docs/specs/checkout.md",
    "buildRef": "releases/{build}.md",
    "expectedRef": "fixtures/{build}/checkout-order.json"
  },
  "Intent": {
    "statement": "A shopper can check out with the discount code {code}",
    "success": ["The confirmation shows an order number"],
    "evidence": [{ "id": "order-record", "hook": "orderPersisted" }]
  },
  "Guardrails": [
    "Use only the test card",
    { "id": "no-refund", "rule": "Never refund an order", "deny": { "actions": ["tool:refund"], "summary": ["refund"] } }
  ],
  "Execution": [
    { "id": "e1", "step": "apply the discount code {code}" },
    { "id": "e2", "verify": "the total shows the discount" },
    { "id": "e3", "step": "pay with the test card" }
  ],
  "Variants": [
    { "id": "save10", "params": { "code": "SAVE10" } },
    { "id": "save10-mobile", "params": { "code": "SAVE10" }, "platforms": ["ios", "android"] }
  ]
}
```

## Where each thing goes

- **Intent** is the case's identity: its statement is the test title, and
  the top-level `id` gives the `cige:<id>` tag. One Intent is one case. Put the outcome in it, never the path ("can check
  out with a discount", not "clicks Apply").
- **Evidence** is what a pass needs beyond the screen. A UI message alone
  is weak: when the Intent claims a record exists, add a hook that checks
  the backend. A hook holds only when it returns `true`; return `false` for
  "not there", and throw only when the check itself can't run.
- **Guardrails** are prose the acting agent reads on every step. Add `deny`
  when the runner must stop the step on an action: an action name
  (`tool:refund`, `navigate`), a prefix ending in `*`, or a regular
  expression over the action's summary. The check runs after the action,
  so keep cases that could do real damage out of environments where it
  counts.
- **Execution** is one goal per `step` (an `agent.act`) or `verify` (an
  `agent.assert`). Give every entry an id; the summary names failures by it.

## Dimensions

Never put a dimension in Intent's meaning. Split them like this:

| Dimension | Field |
| --- | --- |
| Browser, device, platform | `Context.platforms`, or e2e config `targets` |
| Persona or role | `Context.agent` (an `agents.<name>` from the e2e config) |
| Signed-in state | `Context.session` (a session a setup test saved) |
| Needed capability | `Context.requires` |
| Data: codes, amounts, locales, payment methods | `Variants[].params`, used as `{name}` placeholders |

Each variant runs as its own test, tagged `cige:<id>/<variant>`, with its
own summary. A variant may override `platforms`, `agent`, and `session`.
Every param must fill a placeholder, or the case fails to load.

## Refs

`specRef`, `buildRef`, and `expectedRef` are pointers the model never sees.
They are what a classifier compares a failure with, so set them on every
case. `{build}` and `{environment}` are filled in from the config's `build`
and the case's environment.

## The config

`cige.config.ts` declares, once, what the suite, the reporter, and
`e2e-cige` share:

```ts
import { defineCige } from '@e2e-dev/cige';

export default defineCige({
  cases: 'tests/cige/*.cige.json',
  root: new URL('.', import.meta.url), // the suite, reporter, and e2e-cige then read the same files
  build: process.env.GITHUB_SHA,
  hooks: { seedCart, orderPersisted },
  environments: {
    staging: { config: 'e2e.staging.config.ts', reset: resetStaging },
  },
  refs: {
    build: async ({ build }) => ({ text: await releaseNotes(build) }),
    expected: ({ pointer }) => (pointer === undefined ? undefined : { files: [pointer] }),
  },
});
```

Set `e2eConfig` to the e2e config file when the cases don't run under
the nearest `e2e.config.ts`; a replay without an environment config uses
it.

Once `environments` is set, a case whose `Context.environment` names none
of them fails to load, and a case with no `Context.environment` shows as
`environment-unset` in `e2e-cige check`: set it on every case. Register the cases with `cigeSuite(config)` in a `*.e2e.ts` file and
add `cige(config)` to the e2e config's `reporters`.

## Extending

- **Your own fields:** any object takes keys that start with `x-` (for example
  `"x-owner"`, `"x-ticket"`, or `"x-deny-host"` on a guardrail). Never invent a key
  without the prefix: it fails to load. The model never sees `x-` keys
  unless a plugin's `context` adds them, and they are copied into
  summaries, so no secrets.
- **Your own checks:** if the project's `cige.config.ts` has `plugins`, read
  them before writing a case. A plugin's `onAction` may enforce a
  guardrail's `x-` data, its `readiness` may require an `x-` field, and its
  `steps` name the `use` kinds you may write.
- **Your own steps:** `{ "id": "e4", "use": "<kind>", "with": {...} }` runs a
  plugin's step kind, such as an API check, in Execution order. Use one
  only for a kind a plugin registers; `with` may hold `{name}` placeholders
  a variant fills.

## Before you hand a new case over

- `npx e2e run --tag cige:<id>` passes, and its summary has no
  `screen-only-evidence` unless the Intent is about the screen.
- `npx e2e-cige check --resolve` lists no gap for the case: it has a spec
  and a build ref (or resolvers), a build for `{build}`, and an environment
  with a reset, and every resolver runs without an error. Name any gap you
  leave, and why, in the hand-off.
