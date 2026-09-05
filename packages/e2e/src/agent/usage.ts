/** Shared token and cost accounting for executor loops and judgment calls. */
import type { StepModelInfo } from '../run/steps.ts';

type Provenance = Pick<StepModelInfo, 'provider' | 'model' | 'endpoint' | 'adapterVersion' | 'policyVersion'>;

interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly accounting?: StepModelInfo['tokenAccounting'];
  readonly estimatedCostUsd?: number | undefined;
}

/** A provider total is authoritative only when every call reports both token counts. */
export class ModelUsage {
  private records = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private peakTokensPerCall = 0;
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
      ...(typeof this.estimatedCostUsd === 'number' ? { estimatedCostUsd: this.estimatedCostUsd } : {}),
    };
  }
}

/** Rejects counters that cannot be represented in the report schema. */
function tokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
