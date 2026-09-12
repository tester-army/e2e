/**
 * Worker-scoped model adapters. An agent's model is checked once per worker,
 * when the first test acquires that agent: adapter construction checks that a
 * model is configured without a live request. A failure is
 * reported once, to abort the run, instead of surfacing as one blocked step
 * per test. Adapters are shared across every agent that holds the same
 * model instance.
 */

import type { ModelAdapter } from '../agent/model/adapter.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import type { ResolvedAgentConfig, ResolvedModel } from '../config/agent.ts';
import { classifyError, type E2EError } from '../internal/errors.ts';

export class WorkerModels {
  private readonly adapters = new Map<unknown, ModelAdapter>();
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
          // Same instance, same adapter: a judge that is the model costs nothing.
          this.build(agent.model);
          this.build(agent.judge);
        } catch (cause) {
          this.failure = classifyError(cause);
          this.onFailure(this.failure);
        }
      }
    }
    if (this.failure !== undefined) throw this.failure;
  };

  /** Adapter for one resolved model; each distinct model is built once per worker. */
  readonly build = (model: ResolvedModel | undefined): ModelAdapter => {
    if (model === undefined) return createModelAdapter(model);
    const key = modelKey(model);
    let adapter = this.adapters.get(key);
    if (adapter === undefined) {
      adapter = createModelAdapter(model);
      this.adapters.set(key, adapter);
    }
    return adapter;
  };
}

/** Two agents share an adapter when they hold the same model instance. */
function modelKey(model: ResolvedModel): unknown {
  return model.model;
}
