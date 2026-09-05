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
  private estimatedCostUsd: number | undefined;

  /** Accumulates one call, preserving incomplete or estimated provenance across later calls. */
  record(usage: Usage = {}): number {
    this.records += 1;
    const input = tokenCount(usage.inputTokens);
    const output = tokenCount(usage.outputTokens);
    this.inputTokens += input ?? 0;
    this.outputTokens += output ?? 0;
    this.peakTokensPerCall = Math.max(this.peakTokensPerCall, (input ?? 0) + (output ?? 0));
    if (input === undefined || output === undefined || usage.accounting === 'adapter-upper-bound') {
      this.accounting = 'adapter-upper-bound';
    }
    const cost = usage.estimatedCostUsd;
    if (cost !== undefined && Number.isFinite(cost) && cost >= 0) {
      this.estimatedCostUsd = (this.estimatedCostUsd ?? 0) + cost;
    }
    return (input ?? 0) + (output ?? 0);
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
      ...(this.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: this.estimatedCostUsd }),
    };
  }
}

/** Rejects counters that cannot be represented in the report schema. */
function tokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
