/**
 * One `bench-ab.ts` sample: a `report-1` document read down to the timings
 * the harness compares, the counters that should not move between two runs
 * of one build, and a behavior signature per test. Only the fields read here
 * are typed; the report schema (`packages/e2e/schema/report-v1.schema.json`)
 * is the contract.
 */

interface ReportEvent {
  readonly kind: string;
  readonly durationMs: number;
  readonly count?: number;
  readonly bytes?: number;
}

interface ReportStep {
  readonly kind: string;
  readonly api: string;
  readonly label?: string;
  readonly status: string;
  readonly durationMs: number;
  readonly error?: { readonly code?: string };
  readonly cache?: { readonly mode: string; readonly reason?: string };
  readonly metrics?: { readonly modelCalls: number };
  readonly events?: readonly ReportEvent[];
}

interface ReportAttempt {
  readonly status: string;
  readonly durationMs: number;
  readonly error?: { readonly code?: string };
  readonly steps?: readonly ReportStep[];
  readonly members?: readonly { readonly steps: readonly ReportStep[] }[];
}

interface ReportCase {
  readonly file: string;
  readonly titlePath: readonly string[];
  readonly targetId: string;
  readonly agent: string;
  readonly repeat: number;
  readonly status: string;
  readonly serialGroupId?: string;
  readonly attempts: readonly ReportAttempt[];
}

/** The slice of a `report-1` document a sample reads. */
export interface ReportDocument {
  readonly run: {
    readonly exitCode: number;
    readonly results: readonly ReportCase[];
    readonly serialGroups: readonly ReportCase[];
    readonly usage: { readonly modelTokens?: number };
  };
}

/** One test, or one serial group, as a sample sees it. */
export interface CaseSample {
  readonly durationMs: number;
  /** Status, attempts, and every step's kind, api, label, status, error code, and cache mode. */
  readonly signature: string;
}

export interface Sample {
  readonly exitCode: number;
  /** Wall clock of the CLI process, startup and teardown included. */
  readonly wallMs: number;
  /** Named durations compared pair by pair, summed over the run. */
  readonly timings: Readonly<Record<string, number>>;
  /** Counts that two runs of one build should agree on. */
  readonly counters: Readonly<Record<string, number>>;
  readonly cases: ReadonlyMap<string, CaseSample>;
}

/** The name a case keeps across runs and builds: file, titles, target, agent, repeat. */
function caseKey(entry: ReportCase): string {
  const variant = [entry.targetId, entry.agent === 'default' ? undefined : entry.agent, entry.repeat > 0 ? `repeat ${entry.repeat}` : undefined]
    .filter((part) => part !== undefined)
    .join(', ');
  return `${entry.file} › ${entry.titlePath.join(' › ')} (${variant})`;
}

function stepsOf(attempt: ReportAttempt): readonly ReportStep[] {
  return attempt.steps ?? attempt.members?.flatMap((member) => member.steps) ?? [];
}

function stepLine(step: ReportStep): string {
  const parts = [step.kind, step.api, JSON.stringify(step.label ?? ''), step.status];
  if (step.error?.code !== undefined) parts.push(step.error.code);
  if (step.cache !== undefined) parts.push(`cache:${step.cache.mode}${step.cache.reason === undefined ? '' : `:${step.cache.reason}`}`);
  return parts.join(' ');
}

function add(into: Record<string, number>, key: string, value: number): void {
  into[key] = (into[key] ?? 0) + value;
}

/** Reads one report into a sample; `wallMs` is measured by the caller around the process. */
export function sampleFromReport(report: ReportDocument, wallMs: number): Sample {
  const timings: Record<string, number> = { 'suite (sum of attempts)': 0, 'observe (events)': 0, 'action (events)': 0, 'model (events)': 0 };
  const counters: Record<string, number> = {};
  const cases = new Map<string, CaseSample>();
  const entries = [
    ...report.run.results.filter((entry) => entry.serialGroupId === undefined && entry.attempts.length > 0),
    ...report.run.serialGroups.filter((entry) => entry.attempts.length > 0),
  ];
  for (const entry of entries) {
    add(counters, `tests ${entry.status}`, 1);
    add(counters, 'attempts', entry.attempts.length);
    let durationMs = 0;
    const lines = [`status ${entry.status}`, `attempts ${entry.attempts.length}`];
    entry.attempts.forEach((attempt, index) => {
      durationMs += attempt.durationMs;
      lines.push(`attempt ${index + 1} ${attempt.status}${attempt.error?.code === undefined ? '' : ` ${attempt.error.code}`}`);
      for (const step of stepsOf(attempt)) {
        lines.push(`  ${stepLine(step)}`);
        add(counters, 'steps', 1);
        add(timings, `step ${step.api}`, step.durationMs);
        if (step.cache !== undefined) add(counters, `cache ${step.cache.mode}`, 1);
        if (step.metrics !== undefined) add(counters, 'model calls', step.metrics.modelCalls);
        for (const event of step.events ?? []) {
          add(counters, `events ${event.kind}`, 1);
          if (event.kind === 'observation') {
            add(timings, 'observe (events)', event.durationMs);
            add(counters, 'observed nodes', event.count ?? 0);
            add(counters, 'observed bytes', event.bytes ?? 0);
          } else if (event.kind === 'engine') {
            add(timings, 'action (events)', event.durationMs);
          } else if (event.kind === 'model') {
            add(timings, 'model (events)', event.durationMs);
          }
        }
      }
    });
    add(timings, 'suite (sum of attempts)', durationMs);
    cases.set(caseKey(entry), { durationMs, signature: lines.join('\n') });
  }
  add(counters, 'model tokens', report.run.usage.modelTokens ?? 0);
  return { exitCode: report.run.exitCode, wallMs, timings, counters, cases };
}
