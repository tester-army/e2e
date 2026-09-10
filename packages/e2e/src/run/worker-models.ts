/**
 * Worker-scoped model adapters. An agent's model is checked once per worker,
 * when the first test acquires that agent: adapter construction validates the
 * provider shape and the credential without a live request. A failure is
 * reported once, to abort the run, instead of surfacing as one blocked step
 * per test. Adapters are shared by model across every agent that names the
 * same one.
 */

import type { ModelAdapter } from '../agent/model/adapter.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import type { ResolvedAgentConfig, ResolvedModel } from '../config/agent.ts';
import { classifyError, type E2EError } from '../internal/errors.ts';

export class WorkerModels {
  private readonly adapters = new Map<ResolvedModel, ModelAdapter>();
  private readonly checked = new Set<ResolvedAgentConfig>();
  private failure: E2EError | undefined;

  constructor(private readonly onFailure: (error: E2EError) => void) {}

  /**
   * Builds an agent's adapter on its first use and rethrows a failure on
   * every later one. A custom executor with no model configured is exempt:
   * its `act` steps need none, and judgment methods still fail on first use.
   */
  readonly preflight = (agent: ResolvedAgentConfig): void => {
    if (!this.checked.has(agent)) {
      this.checked.add(agent);
      if (agent.executor === undefined || agent.model !== undefined) {
        try {
          this.build(agent.model);
        } catch (cause) {
          this.failure = classifyError(cause);
          this.onFailure(this.failure);
        }
      }
    }
    if (this.failure !== undefined) throw this.failure;
  };

  /** Adapter for one resolved model; each configured model is built once per worker. */
  readonly build = (model: ResolvedModel | undefined): ModelAdapter => {
    if (model === undefined) return createModelAdapter(model);
    let adapter = this.adapters.get(model);
    if (adapter === undefined) {
      adapter = createModelAdapter(model);
      this.adapters.set(model, adapter);
    }
    return adapter;
  };
}
