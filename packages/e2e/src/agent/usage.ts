/** Shared token and cost accounting for executor loops and judgment calls. */
import { bound } from '../cache/trace.ts';
import type { StepEvent, StepModelInfo } from '../run/steps.ts';

type Provenance = Pick<StepModelInfo, 'provider' | 'model' | 'endpoint' | 'adapterVersion' | 'policyVersion'>;

interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Input tokens the provider served from its prompt cache, when it reports the split. */
  readonly cacheReadTokens?: number | undefined;
  /** Input tokens the provider wrote to its prompt cache, when it reports the split. */
  readonly cacheWriteTokens?: number | undefined;
  readonly accounting?: StepModelInfo['tokenAccounting'];
  readonly estimatedCostUsd?: number | undefined;
}

/** A provider total is authoritative only when every call reports both token counts. */
export class ModelUsage {
  private records = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private peakTokensPerCall = 0;
  /** Undefined until a provider reports the cache split; a run that never does omits the fields. */
  private cacheReadTokens: number | undefined;
  private cacheWriteTokens: number | undefined;
  private accounting: StepModelInfo['tokenAccounting'] = 'provider';
  /** Null means the total overflowed and must remain omitted for this step. */
  private estimatedCostUsd: number | null | undefined;

  /** Accumulates one call, preserving incomplete or estimated provenance across later calls. */
  record(usage: Usage = {}): number {
    this.records += 1;
    const input = tokenCount(usage.inputTokens);
    const output = tokenCount(usage.outputTokens);
    this.inputTokens = this.addTokens(this.inputTokens, input ?? 0);
    this.outputTokens = this.addTokens(this.outputTokens, output ?? 0);
    const tokens = this.addTokens(input ?? 0, output ?? 0);
    this.peakTokensPerCall = Math.max(this.peakTokensPerCall, tokens);
    const cacheRead = tokenCount(usage.cacheReadTokens);
    if (cacheRead !== undefined) this.cacheReadTokens = this.addTokens(this.cacheReadTokens ?? 0, cacheRead);
    const cacheWrite = tokenCount(usage.cacheWriteTokens);
    if (cacheWrite !== undefined) this.cacheWriteTokens = this.addTokens(this.cacheWriteTokens ?? 0, cacheWrite);
    if (input === undefined || output === undefined || usage.accounting === 'adapter-upper-bound') {
      this.accounting = 'adapter-upper-bound';
    }
    const cost = usage.estimatedCostUsd;
    if (this.estimatedCostUsd !== null && cost !== undefined && Number.isFinite(cost) && cost >= 0) {
      const total = (this.estimatedCostUsd ?? 0) + cost;
      this.estimatedCostUsd = Number.isFinite(total) ? total : null;
    }
    return tokens;
  }

  /** Saturates unrepresentable sums and marks the step's token counts non-authoritative. */
  private addTokens(left: number, right: number): number {
    const sum = left + right;
    if (Number.isSafeInteger(sum)) return sum;
    this.accounting = 'adapter-upper-bound';
    return Number.MAX_SAFE_INTEGER;
  }

  /** Projects the accumulated usage into the report, including calls that returned no usage. */
  report(provenance: Provenance, calls: number): StepModelInfo {
    return {
      ...provenance,
      calls,
      tokenAccounting: calls > this.records ? 'adapter-upper-bound' : this.accounting,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      peakTokensPerCall: this.peakTokensPerCall,
      ...(this.cacheReadTokens === undefined ? {} : { cacheReadTokens: this.cacheReadTokens }),
      ...(this.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: this.cacheWriteTokens }),
      ...(typeof this.estimatedCostUsd === 'number' ? { estimatedCostUsd: this.estimatedCostUsd } : {}),
    };
  }
}

/**
 * The per-call token split for a model event, each side present only when
 * the provider reported it as a representable count.
 */
export function tokenFields(usage: Usage = {}): Pick<StepEvent, 'inputTokens' | 'outputTokens'> {
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** Rejects counters that cannot be represented in the report schema. */
function tokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Longest reasoning excerpt a `model` step event carries; the AI trace keeps the full text. */
export const MAX_REASONING_CHARS = 600;

/**
 * The `reasoning` field of one model event, absent when the turn produced
 * none. An excerpt, not the transcript: the report schema caps the field at
 * MAX_REASONING_CHARS.
 */
export function reasoningField(text: string | undefined): Pick<StepEvent, 'reasoning'> {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? {} : { reasoning: bound(trimmed, MAX_REASONING_CHARS) };
}
