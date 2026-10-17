import type { experimental_decide, Experimental_DecisionModel, LanguageModel } from 'ai';

/** Options for an executor that acts through a decision model and writes field text with a language model. */
export interface DecisionExecutorOptions {
  /**
   * An AI SDK decision model that answers `choice` questions with a
   * probability distribution, e.g. `typeSafeAi.decisionModel('jev-latest')`.
   * Evaluation models (`evaluationModel()`) work too. An answer without
   * `probabilities`, as a language model reached through a gateway fallback
   * returns, counts as a committed choice: probability 1, confidence 0.
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
   * locate it. With an engine that types into whatever has focus,
   * `type_at` fills a drawn field the same way. The screenshot goes
   * as a file part of the decision state, so the model must take images and
   * answer `score` questions, e.g. `typeSafeAi.decisionModel('jev-latest')`
   * with `@ai-sdk/typesafe-ai` 3.0.19 or later, or
   * `openai.decisionModel('gpt-6-luna')` with `@ai-sdk/openai` 4.0.90 or
   * later. Also honors `agent.assert(..., { vision })`. Default off.
   */
  readonly vision?: boolean;
}

/** Options for a test filter that asks a decision model which tests a change can affect. */
export interface DecisionFilterOptions {
  /**
   * An AI SDK decision model that answers `boolean` questions with a
   * probability, e.g. `gateway.decisionModel('typesafe-ai/jev')`, which
   * reads `AI_GATEWAY_API_KEY`.
   */
  readonly model: Exclude<Experimental_DecisionModel, string>;
  /**
   * Provider options sent with every decide call, such as
   * `{ gateway: { zeroDataRetention: true } }` for Vercel AI Gateway.
   */
  readonly providerOptions?: Parameters<typeof experimental_decide>[0]['providerOptions'];
}
