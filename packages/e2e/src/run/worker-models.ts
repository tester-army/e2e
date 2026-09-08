/**
 * Worker-scoped model adapters. The configured model is checked once per
 * worker, when the first test acquires the `agent` fixture: adapter
 * construction validates the provider shape and the credential without a
 * live request. A failure is reported once, to abort the run, instead of
 * surfacing as one blocked step per test.
 */

import type { ModelAdapter } from '../agent/model/adapter.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import type { ResolvedAgentConfig } from '../config/agent.ts';
import { classifyError, type E2EError } from '../internal/errors.ts';

export class WorkerModels {
  private base: ModelAdapter | undefined;
  private failure: E2EError | undefined;
  private checked = false;

  constructor(
    private readonly agent: ResolvedAgentConfig,
    private readonly onFailure: (error: E2EError) => void,
  ) {}

  /**
   * Builds the base adapter on the first call and rethrows its failure on
   * every later one. A custom executor with no model configured is exempt:
   * its `act` steps need none, and judgment methods still fail on first use.
   */
  readonly preflight = (): void => {
    if (!this.checked) {
      this.checked = true;
      if (this.agent.executor !== undefined && this.agent.model === undefined) return;
      try {
        this.base = createModelAdapter(this.agent.model);
      } catch (cause) {
        this.failure = classifyError(cause);
        this.onFailure(this.failure);
      }
    }
    if (this.failure !== undefined) throw this.failure;
  };

  /** Adapter for one resolved model; the configured base model is built once. */
  readonly build = (model: ResolvedAgentConfig['model']): ModelAdapter => {
    if (model !== undefined && model === this.agent.model) {
      return (this.base ??= createModelAdapter(model));
    }
    return createModelAdapter(model);
  };
}
