# @e2edev/jev

An e2e step executor whose brain is [Jev](https://typesafe.ai), TypeSafe AI's
evaluation model, served through the Vercel AI Gateway as `typesafe-ai/jev`.

Jev does not generate text. It reads a state and answers typed questions in one
parallel pass: a choice with a probability per option, a boolean with a
probability. An act turn is exactly that shape once the vocabulary is spelled
out, so every turn is one round trip of a few hundred milliseconds, priced on
input tokens alone ($0.042 per million, output free).

```ts
import { gateway } from 'ai';
import { jevAgent } from '@e2edev/jev';

export default {
  // ...
  agents: {
    default: {
      executor: jevAgent({ fallback: gateway('openai/gpt-5.6-luna') }),
      model: gateway('openai/gpt-5.6-luna'),
    },
  },
};
```

Requires `ai` 7.0.105 or later (the `experimental_evaluate` API) and
`AI_GATEWAY_API_KEY`.

## What one act turn asks

One `evaluate` call per turn, all questions answered together against the same
state (the step, the ledger, the action history, the screen as node lines):

| question | type | options |
| --- | --- | --- |
| `done` | boolean | is the step already accomplished on this screen |
| `action` | choice | `tap`, `type`, `press_enter`, `select`, `scroll_down`, `scroll_up`, `fail`, filtered to the verbs the engine declared |
| `target` | choice | every enabled interactive node of the observation, keyed by id |
| `value` | choice | the literals the step quotes plus its string params, when there is more than one |

`done` is read first: a probability at or above `doneThreshold` (0.6) ends the
step as passed. `fail` ends it as failed. Otherwise the chosen verb runs
through the harness grammar, so budgets, recording, secret handling and the
trace cache apply exactly as with the default agent.

An assertion is one boolean question. At or above `assertThreshold` (0.7) it
passes, at or below one minus that it fails, in between it is inconclusive.

## What the executor arranges around the model

- **Node ids never come from the model.** The target is a choice over ids the
  observation listed; a hallucinated id is impossible.
- **Values are enumerated.** A step that quotes its literals ("type `alice`")
  needs no generative model. A step that leaves the value open ("a todo of your
  choice") goes to `fallback`, one short completion, and fails with a reason
  when no fallback is configured. Secrets are filled through `typeSecret`, so
  plaintext never reaches any model.
- **Large screens are chosen in two levels.** Jev holds at most 255 options per
  choice; past that the executor asks which page of the screen first.
- **No visible change is seen, not hoped against.** The screen shape is
  compared across turns; an action that changed nothing is reported back in
  the history, and three in a row end the step.

## Measured

Live on 2026-09-17, trace cache off. The e2e web benchmark is the agentic suite
under `packages/web-benchmark/tests-agent` (20 scenarios that the accessibility
tree can carry, 3 skipped). The default agent ran `openai/gpt-5.6-luna-fast`;
Jev ran with that model as the value fallback only.

| e2e web benchmark, one run each | Jev executor | default agent (Luna fast) |
| --- | --- | --- |
| scenarios passed | 17 / 20 (16–17 over four runs) | 20 / 20 |
| run wall time | 218 s | 232 s |
| model calls | 152 | 91 |
| run cost | $0.022 | $0.056 |
| typical act step | 1–5 s | 5–23 s |

The three misses are the same on every run: `lying-labels` (Jev fills the field
whose accessible name matches, not the one visibly labelled), `hover-menu` (it
follows the "back to examples" link the context forbids, then loops), and
`filter-deep-link` (it keeps tapping the filled filter box instead of judging
the filtered list as done). Scroll-heavy scenarios cost more calls than the
default agent, which batches: `infinite-scroll` took 23 turns against 8.

One false pass was found and closed during iteration: on `date-picker` Jev
reported done at 0.90 with "Confirm booking" still to tap. The `pending`
question and the contradiction rule (a confident concrete next action vetoes
"done") now catch it; the deterministic success-message check caught it before.

| public sites, scratch loop | Jev | GPT-5.6 Luna, same loop |
| --- | --- | --- |
| model latency per act turn | 300–1100 ms | 1.2–11.8 s |
| TodoMVC + Sauce Demo steps | 11 / 11 | 11 / 11 |
| 16 assertions against one screen | 16 / 16 in one 0.9 s call | |
| repeatability, 3 runs | identical trajectories | |

Reproduce: `pnpm --filter @e2edev/web-benchmark test:jev` and `test:agent`, then
`node scripts/compare-reports.mjs jev=... default=...` in that package.

## Limits

- Text only: no screenshot or pixel mode. A canvas or a lying accessibility
  tree needs the default agent.
- Nothing generated: values, summaries and reasons come from the step text, the
  fallback, or a fixed template.
- 255 options per choice.
- `experimental_evaluate` is experimental in the AI SDK; the wire shape may
  move.

## Demo

```bash
pnpm build                                   # from the repo root, once
cd packages/jev
AI_GATEWAY_API_KEY=... pnpm run demo         # TodoMVC, headless
AI_GATEWAY_API_KEY=... pnpm run demo:headed  # with the browser and a video per attempt
```
