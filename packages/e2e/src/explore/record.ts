/**
 * The exploration as the runner's process records it: one copy per
 * explorer, kept from the progress each explorer reports as its unit's
 * events, whichever process it runs in. Its snapshot is
 * `run.explore`; with parallel explorers it carries every explorer's steps
 * and the findings once merged.
 */

import { errorMessage } from '../internal/errors.ts';
import type { ReportExplore, ReportExploreFinding, ReportExploreMerge, ReportExploreStep } from '../report/build.ts';
import { explorerCount, explorerOfSpecFile, type ExploreSpec } from './explorer.ts';
import { applyGroups, MergeCallError, validateGroups, type MergeAnswer } from './merge.ts';
import type { ExploreProgress } from './progress.ts';

/** Hears every moment of every explorer as the `explore` run event carries it. */
export type ExploreRecordListener = (event: { readonly progress: ExploreProgress; readonly explorer?: number | undefined }) => void;

/** Asks for the grouping of parallel explorers' findings; see `requestGroups`. */
export type RequestGroups = (findings: readonly ReportExploreFinding[], signal: AbortSignal) => Promise<MergeAnswer>;

/** One explorer's record, as its progress built it. */
interface Copy {
  ended: ReportExplore['ended'];
  summary: string | undefined;
  readonly steps: ReportExploreStep[];
  readonly findings: ReportExploreFinding[];
}

/** Endings from the least complete: the exploration as a whole ended as the first of these any explorer did. */
const ENDINGS: readonly ReportExplore['ended'][] = ['aborted', 'stuck', 'time', 'step-limit', 'finished'];

/** The exploration's record in the runner's process, its explorers' moments on the run's spine, and the merge of their findings. */
export class ExploreRecord {
  readonly #copies: Copy[];
  readonly #listeners: ExploreRecordListener[] = [];
  #merged: { readonly findings: readonly ReportExploreFinding[]; readonly merge: ReportExploreMerge } | undefined;

  constructor(
    private readonly spec: ExploreSpec,
    private readonly requestGroups: RequestGroups,
  ) {
    this.#copies = Array.from({ length: explorerCount(spec) }, () => ({ ended: 'aborted', summary: undefined, steps: [], findings: [] }));
  }

  /** Whether several explorers run. */
  get parallel(): boolean {
    return this.#copies.length > 1;
  }

  /** Registers a listener for every moment from here on. */
  subscribe(listener: ExploreRecordListener): void {
    this.#listeners.push(listener);
  }

  /**
   * Records one moment the explorer whose virtual file is `file` reported (a
   * unit event) and passes it on; a file of no explorer is ignored.
   */
  relay(file: string, progress: ExploreProgress): void {
    const explorer = explorerOfSpecFile(this.spec, file);
    const copy = explorer === undefined ? undefined : this.#copies[explorer - 1];
    if (copy === undefined) return;
    switch (progress.phase) {
      case 'step-finished':
        copy.steps.push(progress.step);
        break;
      case 'finding':
        copy.findings.push(progress.finding);
        break;
      case 'finished':
        copy.ended = progress.ended;
        copy.summary = progress.summary;
        break;
      default:
        break;
    }
    this.#notify(progress, this.parallel ? explorer : undefined);
  }

  /** Passes one moment to every listener, tagged with its explorer when several run. */
  #notify(progress: ExploreProgress, explorer: number | undefined): void {
    for (const listener of this.#listeners) listener({ progress, ...(explorer === undefined ? {} : { explorer }) });
  }

  /**
   * Once every explorer is over: merges the findings of parallel explorers
   * that describe the same failure. Runs once, and not for a run already
   * interrupted or with fewer than two findings. Once the call answered,
   * its usage is recorded whatever happens next: an interrupt meanwhile
   * keeps every finding (`interrupted`), and so does an invalid grouping or
   * a failed call (`failed`, with a notice). Every outcome is announced as a
   * `merge` moment carrying the findings the report keeps.
   */
  async settle(scope: { readonly signal: AbortSignal; readonly notice: (message: string) => void }): Promise<void> {
    if (!this.parallel || this.#merged !== undefined || scope.signal.aborted) return;
    const reported = this.#findings();
    if (reported.length < 2) return;
    const keepAll = (merge: ReportExploreMerge): void => this.#settled(reported, merge);
    let answer: MergeAnswer;
    try {
      answer = await this.requestGroups(reported, scope.signal);
    } catch (cause) {
      // A call that answered before it failed (an answer outside the schema)
      // still cost what it reported; that is counted before either fallback.
      const model = cause instanceof MergeCallError ? cause.usage : undefined;
      const spent = { reported: reported.length, ...(model === undefined ? {} : { model }) };
      if (scope.signal.aborted) return keepAll({ status: 'interrupted', ...spent });
      keepAll({ status: 'failed', ...spent });
      return this.#notMerged(scope, reported.length, cause);
    }
    const accounted = { reported: reported.length, model: answer.usage };
    if (scope.signal.aborted) return keepAll({ status: 'interrupted', ...accounted });
    let partition: number[][];
    try {
      partition = validateGroups(answer.groups, reported.length);
    } catch (cause) {
      keepAll({ status: 'failed', ...accounted });
      return this.#notMerged(scope, reported.length, cause);
    }
    this.#settled(applyGroups(reported, partition), { status: 'merged', ...accounted });
  }

  /** Records how the merge ended and the findings the report keeps, and announces it as a `merge` moment. */
  #settled(findings: readonly ReportExploreFinding[], merge: ReportExploreMerge): void {
    this.#merged = { findings, merge };
    this.#notify({ phase: 'merge', merge, findings }, undefined);
  }

  /** Tells the run that the findings were kept unmerged, and why. */
  #notMerged(scope: { readonly notice: (message: string) => void }, reported: number, cause: unknown): void {
    scope.notice(`the findings of ${String(this.#copies.length)} explorers could not be merged, so all ${String(reported)} are kept: ${errorMessage(cause)}`);
  }

  /** Every explorer's findings in explorer order, each tagged with its explorer and numbered across all of them. */
  #findings(): ReportExploreFinding[] {
    return this.#copies
      .flatMap((copy, position) => copy.findings.map((finding) => ({ ...finding, explorer: position + 1 })))
      .map((finding, index) => ({ ...finding, index }));
  }

  /** The record as `run.explore`: one explorer's as it ran, or every parallel explorer's with the findings once merged. */
  snapshot(): ReportExplore {
    const { goal, budgets } = this.spec;
    const base = { goal, budgets: { maxSteps: budgets.maxSteps, timeoutMs: budgets.timeoutMs } };
    if (!this.parallel) {
      const copy = this.#copies[0]!;
      return {
        ...base,
        ended: copy.ended,
        ...(copy.summary === undefined ? {} : { summary: copy.summary }),
        steps: [...copy.steps],
        findings: [...copy.findings],
      };
    }
    const endings = new Set(this.#copies.map((copy) => copy.ended));
    return {
      ...base,
      ended: ENDINGS.find((ended) => endings.has(ended)) ?? 'aborted',
      steps: this.#copies.flatMap((copy, position) => copy.steps.map((step) => ({ ...step, explorer: position + 1 }))),
      findings: [...(this.#merged?.findings ?? this.#findings())],
      explorers: this.#copies.map((copy, position) => ({
        index: position + 1,
        focus: this.spec.focuses[position]!.label,
        ended: copy.ended,
        ...(copy.summary === undefined ? {} : { summary: copy.summary }),
      })),
      ...(this.#merged === undefined ? {} : { merge: this.#merged.merge }),
    };
  }
}
