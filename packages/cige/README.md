# @e2e-dev/cige

Run [CIGE](https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard)
test cases with e2e. A CIGE case keeps the stable meaning of a test apart
from the parts that drift:

- **Context**: where the test runs.
- **Intent**: why it exists and what a pass needs.
- **Guardrails**: what the agent must never do.
- **Execution**: the first path to try.

The [CIGE guide](https://e2e.tester.army/docs/cige) shows how to write a
case, set up the config, and run it. This README is the reference.

## Contents

- Config
- How a case runs
- Variants
- Run summaries
- Commands
- What `diff` blocks
- Extending

## Config

`cige.config.ts` exports `defineCige({...})`. `cigeSuite(config)` registers
the cases, `cige(config)` in the e2e config's `reporters` writes the
summaries, and `e2e-cige` reads the same file. The command loads it with
plain Node and its type stripping, so use only TypeScript that erases to
JavaScript, and package.json `imports` rather than tsconfig `paths`.

| Option | Does |
| --- | --- |
| `cases` | Globs of `.cige.json` files; default `tests/**/*.cige.json` |
| `root` | Directory the globs resolve against. Set `new URL('.', import.meta.url)` so the suite, reporter, and command agree |
| `hooks` | Precondition and evidence hooks a case names, run inside the test with its fixtures |
| `environments` | By name: `config` (the e2e config that reaches it), and `provision`, `reset`, `teardown` actions. Once set, every `Context.environment` must name one |
| `refs` | `spec`, `build`, `expected` resolvers, run only by `e2e-cige refs` and `check --resolve`, never during a run. What they return is written for an agent to read, so never return a secret |
| `plugins` | See [Extending](#extending) |
| `build` | The build under test, such as `process.env.GITHUB_SHA`: each summary's `build`, and `{build}` in a ref |
| `outputDir` | Where summaries go; default `cige` beside `report.json` |
| `e2eConfig` | The e2e config the cases run under, when it isn't the nearest `e2e.config.ts`; a replay passes it |
| `configFile` | This file's path, when it isn't `cige.config.ts` at the project root; the commands a summary prints pass it as `--config` |

## How a case runs

1. Each precondition hook. It fails only by throwing.
2. `app.open(Context.open)`, when set, so the page loads what the hooks seeded.
3. Each Execution entry: a `step` is one `agent.act` goal with the
   guardrails appended, a `verify` one `agent.assert`, a `use` a plugin's
   step kind.
4. Each piece of evidence. A `hook` holds only when it returns `true`; any
   other value is `ASSERTION_FAILED`. A throw means the check couldn't run:
   an e2e error keeps its code, any other is `ASSERTION_INCONCLUSIVE`.
5. `agent.assert` of the Intent with its `success` and `failure` criteria,
   unless `"judge": false`. Such a case needs evidence or a `verify`, or it
   fails to load.

Context reaches the model as the test's `agentContext`: the system,
environment, actor, preconditions, `facts`, and the files `prompts` names.
The refs, `tools`, and `x-` keys never do.

## Variants

`Variants` runs one case per combination: each variant fills the `{name}`
placeholders in Intent, Execution, evidence, and a `use` step's `with`, and
may override `platforms`, `agent`, and `session`. An `act` step gets the
value as a param; a judgment gets it filled into its text; a `with` string
that is one whole placeholder keeps the value's type. A placeholder nothing
fills, or a param that fills none, fails to load. Each variant is tagged
`cige:<id>/<variant>` and gets its own summary.

## Run summaries

The reporter writes `<output>/cige/<id>.run-summary.json` per result
(`<id>.<variant>…` for a variant, `<id>.<target>.<agent>…` when a case ran
more than once).

- A full run removes the previous summaries and refs first, and no other file.
- A run that leaves cases out (a tag filter, `e2e-cige replay`,
  `--last-failed`) replaces only the summaries of the cases it ran and keeps
  every refs directory. A `--last-failed` rerun also writes one for each
  failure it carried (`carried-from-earlier-run`).
- A test stopped before its verdict gets `result: "interrupted"`.
- The terminal summary gets a `CIGE gaps` row while a case it ran has a
  readiness gap (see `check`).

| Field | Holds |
| --- | --- |
| `result` | `pass`, `fail`, `skipped`, or `interrupted` |
| `failedStep` | The Execution id, evidence id, or `intent` that failed |
| `failureType` | A first guess, below; absent when the evidence can't decide |
| `classification` | `phase`, `errorCode`, `message`, `signals`, and `adjustedBy` when a plugin changed it |
| `specRef`, `buildRef`, `expectedRef` | The case's refs with `{build}` and `{environment}` filled in |
| `resolveRefs`, `replay` | The commands that fetch the refs and replay the result |
| `extensions` | The case's top-level `x-` keys, then each plugin's `summarize` fields under its name |
| `evidence` | Pointers to `report.json`, the trace page, and the artifacts |

`failureType` reads the runner's own error class (`error.category` in
`report.json`) and the step's status, so it follows new codes in e2e:

| What the report says | `failureType` |
| --- | --- |
| A precondition failed, or an `infrastructure` or `configuration` class error (environment, app, credentials, seed data, the model provider), except `POLICY_DENIED` and `REPLAY_STALE` | `infrastructure` |
| An Execution `step` ended `LOCATOR_NOT_FOUND`, `LOCATOR_AMBIGUOUS`, `ACTION_FAILED`, or `REPLAY_STALE` | `outdated-test-logic` |
| A `verify`, evidence, the Intent, or a plugin's check step was judged false (`ASSERTION_FAILED`) | `product-defect` |
| An act step's goal couldn't be reached (`ASSERTION_FAILED`) | Absent, signal `goal-unreachable` |
| A blocked test-class step, a spent budget, the clock, or no conclusion | Absent, signal `automation-limit` |
| A blocked `APP_NOT_OPEN`: the case never opened the app, usually a missing `Context.open` | Absent, no signal |
| A guardrail violation, an agent's refusal citing one, an inconclusive judgment, a plugin step's plain throw | Absent; `guardrail-violation:<id>`, `guardrail-refused:<id>`, `inconclusive-evidence`, `plugin-step-failed:<id>` |

`guardrail-refused` is read from the model's own conclusion (a guardrail's
id, or the word "guardrail"), so it is best effort, like `deny.summary`:
read the trace before acting on it. `guardrail-violation` is the runner's
own record of a `deny` match.

A pass with no evidence hook carries `screen-only-evidence`: check it for a
false positive. A failure without a spec or build ref (and no resolver)
carries `missing-spec-ref` or `missing-build-ref`.

## Commands

```bash
npx e2e-cige replay <id> [--variant <v>] [-- <e2e run options>]
npx e2e-cige env <provision|reset|teardown> <environment>
npx e2e-cige refs <id> [--variant <v>] [--build <build>]
npx e2e-cige check [--resolve] [--warn] [--json]
npx e2e-cige diff [--base origin/main] [--json] [--allow-intent]
```

Every command takes `--config <file>`; the default is `cige.config.ts` in
the working directory.

- `replay` runs the declared environment's `reset` (it refuses one without
  `reset`; declare a no-op one when it keeps no state), then
  `e2e run --tag cige:<id> --no-cache` with the environment's `config`, and
  exits with e2e's code. A case whose environment is prose runs as is.
- `env` runs one environment action and touches no case.
- `refs` writes `<output>/cige/<id>.refs/`: `index.json` and a text file
  per resolver that returned text. A `pointer` alone is one to read
  yourself; a missing key or an `error` means that ref has no ground truth.
- `check` lists each case's gaps and exits 1 on any, unless `--warn`:

| Gap | Fix |
| --- | --- |
| `no-spec-ref`, `no-build-ref` | Set `Context.specRef` / `buildRef`, or a `refs.spec` / `refs.build` resolver |
| `build-unset` | A ref uses `{build}`; set `build` from CI |
| `environment-unset` | Set `Context.environment` |
| `environment-undeclared`, `environment-no-reset` | Declare the environment, with a `reset` |
| `resolver-failed` | With `--resolve`, a resolver threw |
| `plugin` | A plugin's `readiness` hook named it |

## What `diff` blocks

`diff` compares every changed `.cige.json`, the CIGE config, and every
module the config imports against the branch's merge base with `--base`.
It loads the config in its own Node process to see what it imports, then
follows the imports each module names that loading didn't reach, such as a
hook's lazy `import('#hooks/x')`, without running them. These count too:

- A workspace package built to an ignored `dist`: its whole directory, and
  each workspace package it depends on, since a bundler may inline one.
- A symlink to a module, since retargeting it changes what loads.
- The `name`, `type`, `main`, `exports`, and `imports` of each module's
  nearest package.json, since remapping an alias redirects a hook.
- A module the branch deleted or renamed.

It exits 1 on any change that needs a human's approval:

| Blocks | Passes |
| --- | --- |
| Intent statement changed; a criterion, evidence item, guardrail, deny pattern, variant, or case removed; a judgment turned off; an id changed; a variant's data changed | Execution rewritten; criteria, evidence, guardrails, deny patterns, or variants added |
| Any Context change, a removed precondition named | A top-level `x-` key changed (triage data) |
| An `x-` key changed under Intent, evidence, or a guardrail | |
| The CIGE config or a module it imports changed | |
| `config-unverified`: `diff` can't load the config or follow its imports | |

`config-unverified` means the config didn't load, or a module it reaches:

- imports by a computed name, or names a relative or `#` path that doesn't
  resolve;
- imports `node:module`, `node:vm`, `node:worker_threads`,
  `node:inspector`, `node:repl`, `node:test`, or a `data:` URL;
- reads `process.getBuiltinModule`, `process.mainModule`, `.constructor`,
  `eval`, `Function`, or `require` other than as a direct call, or uses
  `with`;
- reads `binding` or `dlopen` on `process`, `globalThis.process`, or
  `node:process`, or hands `process` on;
- doesn't parse;
- is a file git doesn't track, outside any workspace package.

The rule on `.constructor` is by name, so `Base.constructor` blocks, but
`err.constructor.name` doesn't, since it reads only a string. `binding`
and `dlopen` count only on `process`, so `process` may only have a field
read where it's referenced: handing it on, as `const p = process`,
`fn(process)`, or `export default process`, blocks. That rule is by name,
so a local named `process` handed on blocks too.

A workspace package's own sources don't block on a load: the package counts
as a whole, and so does what they import by name, in any TypeScript or JSX
(an `enum` or a decorator included). A load in them that `diff` can't
follow, such as a computed `import()`, isn't seen. A source that doesn't
parse blocks there too, and a module they reach outside every workspace
package is held to all the rules above.

Loading the config runs its top-level code from the branch under review.
Give `diff` the env `e2e run` gets: a config that reads a missing
variable at load blocks every `diff` with `config-unverified`. Run it only
where you'd run the branch's tests. `diff` follows the imports the code
names, so a load built from strings or reached by reflection isn't seen.
Neither is a file a hook runs in a child process or reads as data, app code
the config doesn't import, or an installed package: those need a human's
review.
`--allow-intent` exits 0 anyway and records nothing: gate it on a human's
approval in CI. `--json` reports `intentUnchanged` and the `blocking` count.

## Extending

**`x-` keys.** Every object in a case accepts keys that start with `x-`; any
other unknown key fails to load. The loader keeps them as `extensions`. A
step's `params` and `with` are data and take any key. Put data a plugin
enforces on the guardrail, where `diff` blocks a change, not at the top
level. Keep secrets out: they are committed and copied into summaries.

**Plugins.** `plugins` in the config, each with a `name` (lowercase letters,
digits, dashes, not starting with `x-`) and optional hooks:

| Hook | Runs | Does |
| --- | --- | --- |
| `context` | When the suite registers the case | Adds lines to `agentContext`, the only way an `x-` field reaches the model |
| `onAction` | After every action of an `act` step | A returned `{ guardrail, reason }` stops the step with `POLICY_DENIED` |
| `classify` | In the reporter | Sets or clears (`null`) `failureType` on a failure and adds signals |
| `summarize` | In the reporter | Fields under `extensions.<name>` |
| `readiness` | In `check` and the `CIGE gaps` row | A message, a list, or nothing |
| `steps` | When an Execution entry says `use` | Runs a step kind; `with` is its input |

A step kind returns to pass. Throw an `AgentError` to keep its code
(`ASSERTION_FAILED` for a failed check, `ENVIRONMENT_UNAVAILABLE` for a
backend that is down); any other throw is `ACTION_FAILED` naming the step.
Guardrails don't apply to it. Plugins are your code, with the runner's full
OS authority.

```ts
import { AgentError } from 'e2e';
import type { CigePlugin } from '@e2e-dev/cige';

export const shop: CigePlugin = {
  name: 'shop',
  context: (testCase) => {
    const flags = testCase.context.extensions?.['x-feature-flags'];
    return Array.isArray(flags) ? `Feature flags on: ${flags.join(', ')}` : undefined;
  },
  onAction: (event, testCase) => {
    for (const guardrail of testCase.guardrails) {
      const host = guardrail.extensions?.['x-deny-host'];
      if (typeof host === 'string' && event.summary.includes(host)) return { guardrail: guardrail.id, reason: `${host} is off limits` };
    }
    return undefined;
  },
  steps: {
    'order-api': async ({ step }) => {
      const path = String(step.with.path);
      let response: Response;
      try {
        response = await fetch(new URL(path, 'http://localhost:3000'));
      } catch (cause) {
        throw new AgentError('ENVIRONMENT_UNAVAILABLE', `GET ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (response.status >= 500) throw new AgentError('ENVIRONMENT_UNAVAILABLE', `GET ${path} answered ${response.status}`);
      if (response.status !== step.with.expect) throw new AgentError('ASSERTION_FAILED', `GET ${path} answered ${response.status}`);
    },
  },
  summarize: ({ testCase }) => ({ owner: testCase.extensions?.['x-owner'] ?? 'unowned' }),
  readiness: (testCase) => (testCase.extensions?.['x-owner'] === undefined ? 'no x-owner: nobody is paged when it fails' : undefined),
};
```

The `cige` agent skill (`npx skills add tester-army/e2e --skill cige`)
reads the summaries, classifies each failure, and makes only the repair
that kind allows. The file format is pinned by `schema/cige-1.schema.json`,
generated from the loader's schema at build.
