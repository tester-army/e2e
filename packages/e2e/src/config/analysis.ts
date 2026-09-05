/** Post-failure analysis resolution (spec 05-config.md). */

import { ConfigurationError } from '../internal/errors.ts';
import type { AnalysisConfig, E2EConfig, FailureAnalyzer } from '../types.ts';
import { resolveModel, type ResolvedAgentConfig, type ResolvedModel } from './agent.ts';
import { boundedInt } from './validate.ts';

/** Environment override for the analysis model, mirroring `E2E_MODEL`. */
const ANALYSIS_MODEL_ENV = 'E2E_ANALYSIS_MODEL';

export interface ResolvedAnalysisConfig {
  /**
   * The built-in analyzer's model: `analysis.model`, then `E2E_ANALYSIS_MODEL`,
   * then `agent.model`. Undefined leaves the built-in analyzer unable to run;
   * the failure is then recorded as unanalyzed, never as a run error.
   */
  readonly model: ResolvedModel | undefined;
  /** Custom analyzer; undefined selects the built-in one. Never crosses a process boundary. */
  readonly analyzer: FailureAnalyzer | undefined;
  readonly maxFailures: number;
  readonly vision: boolean;
  readonly source: boolean;
}

const ANALYSIS_KEYS = new Set(['model', 'analyzer', 'maxFailures', 'vision', 'source']);

/**
 * Resolves the `analysis` key. Presence enables analysis; the `--analyze` flag
 * enables it with every default when the config has no block, so a
 * deterministic suite can ask for insight on one run without editing config.
 */
export function resolveAnalysisConfig(
  raw: E2EConfig,
  env: NodeJS.ProcessEnv,
  agent: ResolvedAgentConfig,
  cliAnalyze: boolean | undefined,
): ResolvedAnalysisConfig | undefined {
  const value = raw.analysis;
  if (value === undefined && cliAnalyze !== true) return undefined;
  if (value !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ConfigurationError('INVALID_CONFIG', 'analysis must be an options object');
    }
    for (const key of Object.keys(value)) {
      if (!ANALYSIS_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown analysis config key "${key}"`);
      }
    }
  }
  const analysis: AnalysisConfig = value ?? {};
  if (analysis.analyzer !== undefined && !isFailureAnalyzer(analysis.analyzer)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'analysis.analyzer must implement FailureAnalyzer: { name, analyze(context, options) }',
    );
  }
  if (analysis.vision !== undefined && typeof analysis.vision !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'analysis.vision must be a boolean');
  }
  if (analysis.source !== undefined && typeof analysis.source !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'analysis.source must be a boolean');
  }
  return {
    model:
      resolveModel(analysis.model, env, 'analysis.model', ANALYSIS_MODEL_ENV) ?? agent.model,
    analyzer: analysis.analyzer,
    maxFailures: boundedInt(analysis.maxFailures, 'analysis.maxFailures', 1, 100) ?? 10,
    vision: analysis.vision ?? false,
    source: analysis.source ?? true,
  };
}

/** Structural check, like every other live config value. */
function isFailureAnalyzer(value: unknown): value is FailureAnalyzer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { analyze?: unknown }).analyze === 'function'
  );
}
