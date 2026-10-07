import type { experimental_decide, Experimental_DecisionModel, LanguageModel } from 'ai';

/** Options for an executor that acts through a decision model and writes field text with a language model. */
export interface DecisionExecutorOptions {
  /**
   * An AI SDK decision model that answers `choice` questions with a
   * probability distribution, e.g. `typeSafeAi.decisionModel('jev-latest')`.
   * Evaluation models (`evaluationModel()`) work too. Models that answer
   * without `probabilities` fail the step with MODEL_OUTPUT_INVALID.
   */
  readonly model: Exclude<Experimental_DecisionModel, string>;
  /**
   * A small AI SDK language model that writes field values when the
   * decision model picks `type`. It is exposed as the executor's `model`, so
   * the agent entry's judgment tier (`waitFor`, `extract`) uses it too. It can
   * also come from the agents entry's `model` instead. Without either, `type`
   * is never offered.
   */
  readonly textModel?: Exclude<LanguageModel, string>;
  /** Minimum probability for a selected operation, target, secret, or assertion verdict. Default 0 (off). */
  readonly minProbability?: number;
  /** Minimum provider-reported confidence. Default 0 (off). A model that reports none counts as 0. */
  readonly minConfidence?: number;
  /**
   * Provider options sent with every decide call, such as
   * `{ gateway: { zeroDataRetention: true } }` for Vercel AI Gateway. They reach
   * the decision model only: the text model keeps the agents entry's
   * `providerOptions`, so options meant for one model never reach the other.
   */
  readonly providerOptions?: Parameters<typeof experimental_decide>[0]['providerOptions'];
  /**
   * Show the decision model a masked screenshot beside the element table on
   * every question, and offer `tap_at` over a grid of screenshot cells when
   * the engine taps points. Needs a decision model that takes images, e.g.
   * `openaiDecisionModel()`; the AI SDK's own `openai.decisionModel()` sends
   * text only. Also honors `agent.assert(..., { vision })`. Default off.
   */
  readonly vision?: boolean;
}
