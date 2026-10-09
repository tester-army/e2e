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
   * Ask for masked pixels on every observation. Assertions and completion
   * checks see the screenshot beside the page, and `tap_at` is offered for
   * a drawn control when the engine taps points and a text model is set:
   * the text model names it, and score questions over the screenshot
   * locate it. The screenshot goes
   * as a file part of the decision state, so the model must take images and
   * answer `score` questions, e.g. `openai.decisionModel('gpt-6-luna')` with
   * `@ai-sdk/openai` 4.0.90 or later; a text-only model such as Jev refuses
   * the file. Also honors `agent.assert(..., { vision })`. Default off.
   */
  readonly vision?: boolean;
}
