/**
 * The slice of a `report-1` document and of an `ai-trace.json` the bench
 * reads. Structural types over the JSON, kept to the fields the scorers use,
 * so the bench depends on the published wire format and not on the runner's
 * internals. The schema is `packages/e2e/schema/report-v1.schema.json`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface StepEvent {
  readonly kind: string;
  readonly durationMs: number;
}

export interface StepModel {
  readonly provider: string;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface StepRecord {
  readonly kind: string;
  readonly api: string;
  readonly status: string;
  readonly durationMs: number;
  readonly metrics?: { readonly modelCalls: number; readonly actionSteps: number };
  readonly model?: StepModel;
  readonly events: readonly StepEvent[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AttemptRecord {
  readonly index: number;
  readonly status: string;
  readonly durationMs: number;
  readonly steps: readonly StepRecord[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface TestRecord {
  readonly testId: string;
  readonly titlePath: readonly string[];
  readonly file: string;
  readonly status: string;
  readonly attempts: readonly AttemptRecord[];
  readonly skip?: { readonly reason?: string };
}

export interface Finding {
  readonly kind: 'issue' | 'warning';
  readonly severity: number;
  readonly title: string;
  readonly expected: string;
  readonly actual: string;
  readonly reportedAt: string;
  readonly artifactId?: string;
}

export interface ExploreRecord {
  readonly ended: string;
  readonly steps: readonly { readonly status: string; readonly title: string }[];
  readonly findings: readonly Finding[];
  readonly summary?: string;
}

export interface Report {
  readonly schemaVersion: string;
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly runner: { readonly name: string; readonly version: string };
    readonly results: readonly TestRecord[];
    readonly usage: {
      readonly modelTokens: number;
      readonly modelCachedTokens?: number;
      readonly estimatedCostUsd?: number;
    };
    readonly explore?: ExploreRecord;
    readonly errors: readonly { readonly code: string; readonly message: string }[];
  };
}

/** The report a run wrote next to its artifacts, or undefined when the run never got that far. */
export function readReport(runDir: string): Report | undefined {
  const file = path.join(runDir, 'report.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as Report;
}

/** The devtools-shaped AI trace: runs attribute steps (model calls) to tests. */
interface AiTrace {
  readonly runs: readonly { readonly id: string; readonly e2e?: { readonly testId?: string } }[];
  readonly steps: readonly { readonly run_id: string; readonly usage: string | null }[];
}

/**
 * Reasoning tokens per test id, read from the AI trace: the report has no
 * field for them, and they are the cost wildcard between models. The usage
 * object is the AI SDK's, stored as a JSON string; the v7 shape nests the
 * count under `outputTokens.reasoning`, older shapes call it `reasoningTokens`.
 */
export function reasoningTokensByTest(runDir: string): ReadonlyMap<string, number> {
  const file = path.join(runDir, 'ai-trace.json');
  const totals = new Map<string, number>();
  if (!existsSync(file)) return totals;
  const trace = JSON.parse(readFileSync(file, 'utf8')) as AiTrace;
  const testByRun = new Map<string, string>();
  for (const run of trace.runs) {
    if (run.e2e?.testId !== undefined) testByRun.set(run.id, run.e2e.testId);
  }
  for (const step of trace.steps) {
    const testId = testByRun.get(step.run_id);
    if (testId === undefined || step.usage === null) continue;
    totals.set(testId, (totals.get(testId) ?? 0) + reasoningTokens(step.usage));
  }
  return totals;
}

function reasoningTokens(usageJson: string): number {
  try {
    const usage = JSON.parse(usageJson) as {
      outputTokens?: number | { reasoning?: number };
      reasoningTokens?: number;
      outputTokenDetails?: { reasoningTokens?: number };
    };
    if (typeof usage.outputTokens === 'object' && typeof usage.outputTokens?.reasoning === 'number') {
      return usage.outputTokens.reasoning;
    }
    return usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens ?? 0;
  } catch {
    return 0;
  }
}
