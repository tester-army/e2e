/**
 * Post-failure analysis orchestration. Lives in the runner process: results
 * arrive from workers already final, the evidence is on disk, and the model
 * call needs no session. Analyses run beside the remaining tests, bounded in
 * number and concurrency, and every outcome — a verdict or the reason there
 * is none — lands on the result record and the event stream. Nothing here can
 * change a status, delay a retry, or fail the run.
 */

import type { ResolvedConfig } from '../config/resolve.ts';
import { withAiTraceScope } from '../internal/ai-trace.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { errorMessage, sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import { createRedactor } from '../internal/redact.ts';
import type { RunEventFact } from '../run/events.ts';
import type { FailureAnalysisRecord, ResultRecord } from '../run/records.ts';
import type { FailureAnalysis } from '../types.ts';
import { buildFailureContext, isAnalyzable } from './context.ts';
import { createDefaultAnalyzer, DEFAULT_ANALYZER_NAME, validateAnalysis } from './default-analyzer.ts';

/** One analysis, evidence assembly and model call included. */
const ANALYSIS_TIMEOUT_MS = 90_000;
/** Analyses in flight at once; the rest queue behind them. */
const MAX_CONCURRENT_ANALYSES = 2;
const MAX_UNAVAILABLE_MESSAGE_BYTES = 1024;

export interface FailureAnalysisRunnerOptions {
  readonly config: ResolvedConfig;
  readonly artifactsRoot: string;
  readonly interruptSignal: AbortSignal;
  readonly emit: (fact: RunEventFact) => void;
  readonly debug: DebugTrace;
}

export class FailureAnalysisRunner {
  private readonly pending = new Set<Promise<void>>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  private started = 0;
  /** Output redaction over the passwords known up front; evidence arrives already redacted. */
  private readonly redact: (text: string) => string;

  constructor(private readonly options: FailureAnalysisRunnerOptions) {
    this.redact = createRedactor(
      [...options.config.credentials].flatMap(([name, { password }]) =>
        typeof password === 'string' ? [[name, password] as const] : [],
      ),
    );
  }

  /** Queues one result for analysis when it qualifies; returns at once either way. */
  consider(result: ResultRecord): void {
    const analysis = this.options.config.analysis;
    if (analysis === undefined || !isAnalyzable(result)) return;
    const analyzerName = analysis.analyzer?.name ?? DEFAULT_ANALYZER_NAME;
    if (this.started >= analysis.maxFailures) {
      this.attach(result, {
        status: 'unavailable',
        analyzer: analyzerName,
        reason: 'limit-reached',
        message: `analysis.maxFailures (${analysis.maxFailures}) already analyzed this run`,
        durationMs: 0,
      });
      return;
    }
    if (analysis.analyzer === undefined && analysis.model === undefined) {
      this.attach(result, {
        status: 'unavailable',
        analyzer: analyzerName,
        reason: 'no-model',
        message: 'no analysis model: set analysis.model, E2E_ANALYSIS_MODEL, or agent.model',
        durationMs: 0,
      });
      return;
    }
    this.started += 1;
    const job = this.slot(() => this.analyze(result)).catch(() => undefined);
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** Resolves once every queued analysis has attached its record. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_ANALYSES) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private async analyze(result: ResultRecord & { status: 'failed' | 'timed-out' }): Promise<void> {
    const { config, interruptSignal } = this.options;
    const analysisConfig = config.analysis;
    if (analysisConfig === undefined) return;
    const startedMs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
    const onInterrupt = (): void => controller.abort();
    interruptSignal.addEventListener('abort', onInterrupt, { once: true });
    if (interruptSignal.aborted) controller.abort();

    // One built-in analyzer per analysis: it keeps the usage of the call it
    // made, which the record reports as provenance.
    const builtIn =
      analysisConfig.analyzer !== undefined || analysisConfig.model === undefined
        ? undefined
        : createDefaultAnalyzer({
            model: analysisConfig.model,
            maxInputTokens: config.limits.maxModelTokensPerCall,
            timeoutMs: ANALYSIS_TIMEOUT_MS,
          });
    const analyzer = analysisConfig.analyzer ?? builtIn;
    if (analyzer === undefined) return;
    const final = result.attempts.at(-1);

    let record: FailureAnalysisRecord;
    try {
      const context = await buildFailureContext(result, {
        artifactsRoot: this.options.artifactsRoot,
        projectRoot: config.projectRoot,
        source: analysisConfig.source,
        vision: analysisConfig.vision,
      });
      const raw = await this.options.debug.time('analysis', () =>
        withAiTraceScope(
          {
            test: result.test.titlePath.join(' › '),
            testId: result.test.id,
            target: result.target.name,
            attempt: final?.index ?? 0,
            api: 'analysis',
            label: 'failure analysis',
          },
          () => analyzer.analyze(context, { signal: controller.signal }),
        ),
      );
      // A custom analyzer's answer is held to the same closed grammar as the
      // built-in one, so the report never carries an unbounded field.
      const validation = validateAnalysis(raw);
      if (!validation.ok) throw new Error(`analyzer returned an invalid analysis: ${validation.issue}`);
      const analysis = this.redactAnalysis(validation.value);
      const usage = builtIn?.lastUsage();
      record = {
        status: 'analyzed',
        analyzer: analyzer.name,
        ...analysis,
        evidence: [...analysis.evidence],
        artifacts: {
          ...(final?.evidence?.screenshot === undefined ? {} : { screenshot: final.evidence.screenshot }),
          ...(final?.evidence?.observation === undefined ? {} : { observation: final.evidence.observation }),
        },
        ...(builtIn === undefined || usage === undefined
          ? {}
          : {
              model: {
                provider: builtIn.provenance.provider,
                model: builtIn.provenance.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                ...(usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: usage.estimatedCostUsd }),
              },
            }),
        durationMs: Date.now() - startedMs,
      };
    } catch (cause) {
      record = {
        status: 'unavailable',
        analyzer: analyzer.name,
        reason: interruptSignal.aborted ? 'interrupted' : controller.signal.aborted ? 'timed-out' : 'failed',
        message: truncateUtf8(sanitizeText(this.redact(errorMessage(cause))), MAX_UNAVAILABLE_MESSAGE_BYTES),
        durationMs: Date.now() - startedMs,
      };
    } finally {
      clearTimeout(timer);
      interruptSignal.removeEventListener('abort', onInterrupt);
    }
    this.attach(result, record);
  }

  private redactAnalysis(analysis: FailureAnalysis): FailureAnalysis {
    return {
      classification: analysis.classification,
      confidence: analysis.confidence,
      summary: this.redact(analysis.summary),
      evidence: analysis.evidence.map((item) => this.redact(item)),
      ...(analysis.suggestedFix === undefined ? {} : { suggestedFix: this.redact(analysis.suggestedFix) }),
    };
  }

  private attach(result: ResultRecord, record: FailureAnalysisRecord): void {
    result.analysis = record;
    this.options.emit({
      type: 'analysis',
      testId: result.test.id,
      title: result.test.titlePath.join(' › '),
      target: result.target.name,
      analysis: record,
    });
  }
}
