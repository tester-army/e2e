/**
 * Post-run failure analysis orchestration. Lives in the runner process:
 * results arrive from workers already final, the evidence is on disk, and the
 * model call needs no session. Analyses run beside the remaining tests,
 * bounded in number and concurrency, and every outcome — a verdict or the
 * reason there is none — lands on the result record and the event stream.
 * Nothing here can change a status, delay a retry, or fail the run.
 */

import type { ResolvedConfig } from '../config/resolve.ts';
import { withAiTraceScope } from '../internal/ai-trace.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { errorMessage, sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import { createRedactor } from '../internal/redact.ts';
import { withTimeout } from '../internal/time.ts';
import type { RunEventFact } from '../run/events.ts';
import type { FailureAnalysisRecord, ResultRecord } from '../run/records.ts';
import type { CollectedEvidence, FailureAnalysis, FailureContext, FailureEvidenceProvider } from '../types.ts';
import { analyzedAttempt, buildFailureContext, isAnalyzable, type AnalyzableResult } from './context.ts';
import { createDefaultAnalyzer, DEFAULT_ANALYZER_NAME, validateAnalysis } from './default-analyzer.ts';

/** One analysis, evidence assembly and model call included. */
const ANALYSIS_TIMEOUT_MS = 90_000;
/** One evidence provider's `collect`, inside the analysis budget. */
const EVIDENCE_TIMEOUT_MS = 15_000;
/** Bytes one provider's text may occupy in the context. */
const MAX_EVIDENCE_BYTES = 16 * 1024;
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
  /** Output redaction over the secret values known up front; evidence arrives already redacted. */
  private readonly redact: (text: string) => string;

  constructor(private readonly options: FailureAnalysisRunnerOptions) {
    this.redact = createRedactor(
      [...options.config.secrets].flatMap(([name, { value }]) =>
        typeof value === 'string' ? [[name, value] as const] : [],
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
        message: 'no analysis model: set analysis.model or agents.default.model to an AI SDK model instance',
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

  private async analyze(result: AnalyzableResult): Promise<void> {
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
            instructions: analysisConfig.instructions,
            maxInputTokens: config.limits.maxModelTokensPerCall,
            timeoutMs: ANALYSIS_TIMEOUT_MS,
          });
    const analyzer = analysisConfig.analyzer ?? builtIn;
    if (analyzer === undefined) return;
    const attempt = analyzedAttempt(result);

    let record: FailureAnalysisRecord;
    try {
      const base = await buildFailureContext(result, {
        artifactsRoot: this.options.artifactsRoot,
        projectRoot: config.projectRoot,
        source: analysisConfig.source,
        vision: analysisConfig.vision,
      });
      const context = await this.withEvidence(base, analysisConfig.evidence, controller.signal);
      const raw = await this.options.debug.time('analysis', () =>
        withAiTraceScope(
          {
            test: result.test.titlePath.join(' › '),
            testId: result.test.id,
            target: result.target.name,
            agent: result.agent,
            attempt: attempt?.index ?? 0,
            api: 'analysis',
            label: 'failure analysis',
          },
          () => analyzer.analyze(context, { signal: controller.signal }),
        ),
      );
      // A custom analyzer's answer is held to the same closed grammar as the
      // built-in one, so the report never carries an unbounded field.
      const validation = validateAnalysis(raw, context.observation);
      if (!validation.ok) throw new Error(`analyzer returned an invalid analysis: ${validation.issue}`);
      const analysis = this.redactAnalysis(validation.value);
      const usage = builtIn?.lastUsage();
      record = {
        status: 'analyzed',
        analyzer: analyzer.name,
        ...analysis,
        evidence: [...analysis.evidence],
        artifacts: {
          ...(attempt?.failure?.screenshot === undefined ? {} : { screenshot: attempt.failure.screenshot }),
          ...(attempt?.failure?.screen === undefined ? {} : { screen: attempt.failure.screen }),
        },
        sources: context.evidence.map((item) => item.name),
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

  /**
   * Runs the configured evidence providers in order, each bounded on its own,
   * and hands each the context so far, so a later provider can read what an
   * earlier one found. A provider that throws, times out, or returns nothing
   * contributes nothing; the analysis proceeds on the rest.
   */
  private async withEvidence(
    base: FailureContext,
    providers: readonly FailureEvidenceProvider[],
    signal: AbortSignal,
  ): Promise<FailureContext> {
    if (providers.length === 0) return base;
    const collected: CollectedEvidence[] = [];
    for (const provider of providers) {
      if (signal.aborted) break;
      const context: FailureContext = { ...base, evidence: [...collected] };
      const text = await this.options.debug
        .time('analysis.evidence', () =>
          withTimeout(
            Promise.resolve().then(() => provider.collect(context, { signal })),
            EVIDENCE_TIMEOUT_MS,
            () => new Error(`evidence provider "${provider.name}" timed out`),
          ),
        )
        .catch(() => undefined);
      if (typeof text !== 'string') continue;
      const bounded = truncateUtf8(this.redact(sanitizeText(text)), MAX_EVIDENCE_BYTES);
      if (bounded.trim() === '') continue;
      collected.push({
        name: provider.name,
        text: bounded === text ? bounded : `${bounded}\n[evidence truncated for analysis]`,
      });
    }
    return { ...base, evidence: collected };
  }

  private redactAnalysis(analysis: FailureAnalysis): FailureAnalysis {
    return {
      classification: analysis.classification,
      confidence: analysis.confidence,
      summary: this.redact(analysis.summary),
      evidence: analysis.evidence.map((item) => this.redact(item)),
      ...(analysis.suggestedFix === undefined ? {} : { suggestedFix: this.redact(analysis.suggestedFix) }),
      ...(analysis.suggestedLocator === undefined
        ? {}
        : {
            suggestedLocator: {
              role: analysis.suggestedLocator.role,
              name: this.redact(analysis.suggestedLocator.name),
            },
          }),
    };
  }

  private attach(result: ResultRecord, record: FailureAnalysisRecord): void {
    result.analysis = record;
    this.options.emit({
      type: 'analysis',
      testId: result.test.id,
      agent: result.agent,
      title: result.test.titlePath.join(' › '),
      target: result.target.name,
      analysis: record,
    });
  }
}
