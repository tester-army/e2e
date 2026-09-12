/** Post-run failure analysis resolution. */

import { ConfigurationError } from '../internal/errors.ts';
import type { AnalysisConfig, E2EConfig, FailureAnalyzer, FailureEvidenceProvider } from '../types.ts';
import { resolveModel, type ResolvedAgentConfig, type ResolvedModel } from './agent.ts';
import { boundedInt } from './validate.ts';

/** Bytes of project instructions the built-in analyzer's policy admits. */
const MAX_INSTRUCTIONS_BYTES = 8 * 1024;

export interface ResolvedAnalysisConfig {
  /**
   * The built-in analyzer's model: `analysis.model`, then the default
   * agent's. Undefined leaves the built-in analyzer unable to run; the
   * failure is then recorded as unanalyzed, never as a run error.
   */
  readonly model: ResolvedModel | undefined;
  /** Trusted project text appended to the built-in analyzer's policy. */
  readonly instructions: string | undefined;
  /** Evidence providers, in config order. Live values; never cross a process boundary. */
  readonly evidence: readonly FailureEvidenceProvider[];
  /** Custom analyzer; undefined selects the built-in one. Never crosses a process boundary. */
  readonly analyzer: FailureAnalyzer | undefined;
  readonly maxFailures: number;
  readonly vision: boolean;
  readonly source: boolean;
}

const ANALYSIS_KEYS = new Set(['model', 'instructions', 'evidence', 'analyzer', 'maxFailures', 'vision', 'source']);

/**
 * Resolves the `analysis` key. Presence enables analysis; the `--analyze` flag
 * enables it with every default when the config has no block, so a suite can
 * ask for insight on one run without editing its config.
 */
export function resolveAnalysisConfig(
  raw: E2EConfig,
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
  if (analysis.analyzer !== undefined && !isNamedWithMethod(analysis.analyzer, 'analyze')) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'analysis.analyzer must implement FailureAnalyzer: { name, analyze(context, options) }',
    );
  }
  if (analysis.evidence !== undefined) {
    if (!Array.isArray(analysis.evidence)) {
      throw new ConfigurationError('INVALID_CONFIG', 'analysis.evidence must be an array of evidence providers');
    }
    const names = new Set<string>();
    for (const provider of analysis.evidence) {
      if (!isNamedWithMethod(provider, 'collect')) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          'analysis.evidence entries must implement FailureEvidenceProvider: { name, collect(context, options) }',
        );
      }
      if (names.has(provider.name)) {
        throw new ConfigurationError('INVALID_CONFIG', `analysis.evidence names a provider "${provider.name}" twice`);
      }
      names.add(provider.name);
    }
  }
  if (analysis.instructions !== undefined) {
    if (typeof analysis.instructions !== 'string') {
      throw new ConfigurationError('INVALID_CONFIG', 'analysis.instructions must be a string');
    }
    if (new TextEncoder().encode(analysis.instructions).byteLength > MAX_INSTRUCTIONS_BYTES) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `analysis.instructions must be at most ${MAX_INSTRUCTIONS_BYTES} bytes`,
      );
    }
  }
  if (analysis.vision !== undefined && typeof analysis.vision !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'analysis.vision must be a boolean');
  }
  if (analysis.source !== undefined && typeof analysis.source !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'analysis.source must be a boolean');
  }
  const instructions = analysis.instructions?.trim();
  return {
    model: resolveModel(analysis.model, 'analysis.model') ?? agent.model,
    instructions: instructions === undefined || instructions === '' ? undefined : instructions,
    evidence: analysis.evidence ?? [],
    analyzer: analysis.analyzer,
    maxFailures: boundedInt(analysis.maxFailures, 'analysis.maxFailures', 1, 100) ?? 10,
    vision: analysis.vision ?? false,
    source: analysis.source ?? true,
  };
}

/** Structural check, like every other live config value. */
function isNamedWithMethod(value: unknown, method: string): value is { readonly name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    (value as { name: string }).name !== '' &&
    typeof (value as Record<string, unknown>)[method] === 'function'
  );
}
