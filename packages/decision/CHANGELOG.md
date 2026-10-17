# @e2e-dev/decision

## 0.2.4

### Patch Changes

- [#1035](https://github.com/tester-army/e2e/pull/1035) [`7e568f2`](https://github.com/tester-army/e2e/commit/7e568f2826aeb08ffa3fd0a263c579df578d8d26) Thanks [@rudycelekli](https://github.com/rudycelekli)! - Count the tokens and served model of a model call that returns while its step is being cancelled.

## 0.2.3

### Patch Changes

- [#1160](https://github.com/tester-army/e2e/pull/1160) [`7086ac3`](https://github.com/tester-army/e2e/commit/7086ac34f962c66666d3ee415d4d4780b85ed370) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `vision: true` works with TypeSafe Jev through `@ai-sdk/typesafe-ai` 3.0.19 or later. `tap_at` takes a third, tighter look before it taps, so it hits small drawn controls such as map pins. New `type_at` fills a field drawn on a canvas: the text model names the field and its value, the screenshot locates it, and the keyboard types into it.

- [#883](https://github.com/tester-army/e2e/pull/883) [`5fce7b2`](https://github.com/tester-army/e2e/commit/5fce7b2bfecc2d912223198ce6bcf4c13d0e707c) Thanks [@pvedula7](https://github.com/pvedula7)! - Executor observations carry `keyboardVisible`, the engine's measured on-screen keyboard state, absent when it can't tell. The mobile engine sets it, and the decision executor uses it to offer `dismiss_keyboard`.

## 0.2.2

### Patch Changes

- [#1101](https://github.com/tester-army/e2e/pull/1101) [`4b4b297`](https://github.com/tester-army/e2e/commit/4b4b29727dde17eb135b030c031c10607a2d6299) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A decision answer with no probability distribution, as a language model answering through an AI Gateway decision fallback returns, now counts as a committed choice with probability 1 and confidence 0 instead of failing the step with `MODEL_OUTPUT_INVALID`. The docs show how to set a confidence-based gateway fallback on the executor.

- [#942](https://github.com/tester-army/e2e/pull/942) [`aedc393`](https://github.com/tester-army/e2e/commit/aedc393108b50be6741d936901db2a6018496889) Thanks [@HoneyTyagii](https://github.com/HoneyTyagii)! - The completion check now sees the step origin path when it differs from the current page.

## 0.2.1

### Patch Changes

- [#843](https://github.com/tester-army/e2e/pull/843) [`ac657d1`](https://github.com/tester-army/e2e/commit/ac657d1d0c063cd19ee458ee1d645783bf1ef8ce) Thanks [@pvedula7](https://github.com/pvedula7)! - The decision executor offers `dismiss_keyboard` while an on-screen keyboard is showing and the engine can dismiss it. Before, a control the keyboard covered after typing (an iOS number pad over a submit button) could not be reached, and the step failed.

- [#910](https://github.com/tester-army/e2e/pull/910) [`42ce272`](https://github.com/tester-army/e2e/commit/42ce272c9ccc8e59571eaa14122e55ed85554b29) Thanks [@Ashfaqbs](https://github.com/Ashfaqbs)! - The decision executor now forwards an element's `selected` state to the model, the same way it already forwards `checked` and `expanded`. Without it, a tab bar's active tab looked identical to the rest, so the completion check for a tab switch landed near 50/50 and sometimes blocked a step that actually worked, or claimed a step done before anything was tapped.

- [#844](https://github.com/tester-army/e2e/pull/844) [`5e55d7c`](https://github.com/tester-army/e2e/commit/5e55d7c92d67f9b8741c7835ef23de5d62c637c2) Thanks [@pvedula7](https://github.com/pvedula7)! - The decision executor's stall guard now counts an action that errored as no progress, so three actions in a row that failed or changed nothing on screen block the step. It used to look only at whether the page changed, and a ticking timer on screen changes it every time: a tap that failed with `APP_UNREACHABLE` again and again never tripped the guard, and the model could repeat it until it gave up and claimed the step failed. A skipped pick and a rejected `done` or `failed` claim also carry an error in the step's history, so they count toward the three as well.

## 0.2.0

### Minor Changes

- [#965](https://github.com/tester-army/e2e/pull/965) [`b92658b`](https://github.com/tester-army/e2e/commit/b92658be6eb61a086c30b11fc36399872b863910) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Ask the operation first and its target second, with the goal and the recent actions in every question. Every target question carries a `none` option. Offer the whole action grammar: hover, right-click, double-tap, long-press, drag, scroll-to, and upload. Add `vision: true`, which sends the screenshot as a file part of the decision state (`ai` 7.0.134, `openai.decisionModel('gpt-6-luna')` with `@ai-sdk/openai` 4.0.90) for screenshot verdicts and a `tap_at` that the text model names and score questions locate. Name a provider refusal.

- [#937](https://github.com/tester-army/e2e/pull/937) [`f1a1ac2`](https://github.com/tester-army/e2e/commit/f1a1ac241042c089ae773213c4e4f0da34f2f3d8) Thanks [@outof-place](https://github.com/outof-place)! - `decisionExecutor({ providerOptions })` sends provider options with every decide call, the completion checks included, such as `{ gateway: { zeroDataRetention: true } }` for Vercel AI Gateway. They reach the decision model only: the text model keeps the agents entry's `providerOptions`. A value that does not map provider names to option objects fails config load with `INVALID_CONFIG`.

## 0.1.0

### Minor Changes

- [#775](https://github.com/tester-army/e2e/pull/775) [`d1f2089`](https://github.com/tester-army/e2e/commit/d1f2089081219ab0a8a07d49adb0195623738b40) Thanks [@guhcostan](https://github.com/guhcostan)! - Add `@e2e-dev/decision`, an executor that runs `agent.act` and `agent.assert`
  through a decision model instead of an LLM. It takes any AI SDK decision
  model with choice distributions (`evaluationModel()` instances too) and
  decides through `experimental_decide`, so it needs `ai` 7.0.128 or later. One
  call per action fans out the operation and target questions; a small
  language model writes field values when the choice is `type`. Tests stay
  plain natural language with no params. Probability and confidence gates are
  off by default. A model id string or a language model fails config load with
  `INVALID_CONFIG`.
