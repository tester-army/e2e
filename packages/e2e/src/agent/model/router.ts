/** Which model an invocation talks to (spec 05-config.md). */

import type { ResolvedAgentConfig } from '../../config/agent.ts';
import type { ModelAdapter } from './adapter.ts';

/**
 * Picks the adapter for one invocation.
 *
 * `agent.visionModel` exists because visual grounding is a much higher bar than
 * accepting an image, and pinning it separately keeps every text-only call on the
 * cheaper model. The vision adapter is built on first use rather than at fixture
 * acquisition: a project that pins a vision model must not fail a run that never
 * asks for pixels, for example because that model's credential is absent from
 * this environment.
 */
export class ModelRouter {
  private baseAdapter: ModelAdapter | undefined;
  private visionAdapter: ModelAdapter | undefined;

  constructor(
    private readonly buildBase: () => ModelAdapter,
    private readonly buildVision: (() => ModelAdapter) | undefined,
  ) {}

  /**
   * The adapter for a call. An invocation that is sending pixels keeps the vision
   * model for the rest of its lifetime, including rounds whose pixels were
   * withheld, so a polling method never switches models between rounds.
   */
  select(vision: boolean): ModelAdapter {
    if (!vision || this.buildVision === undefined) {
      return (this.baseAdapter ??= this.buildBase());
    }
    return (this.visionAdapter ??= this.buildVision());
  }
}

/**
 * Builds the router for one attempt from resolved agent config.
 *
 * The base adapter is built on first use, like the vision adapter: a run whose
 * `agent.act()` steps go to a custom executor may legitimately have no model at
 * all, and must not fail on a MODEL_UNAVAILABLE it would never hit. Judgment
 * and locate methods still fail with MODEL_UNAVAILABLE on their first call.
 */
export function createModelRouter(
  agent: ResolvedAgentConfig,
  build: (model: ResolvedAgentConfig['model']) => ModelAdapter,
): ModelRouter {
  const visionModel = agent.visionModel;
  return new ModelRouter(
    () => build(agent.model),
    visionModel === undefined ? undefined : () => build(visionModel),
  );
}
