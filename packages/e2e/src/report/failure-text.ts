/**
 * A failed test as text: the facts the run page's failure block states (what
 * the error said in structured form, whether the attempts failed alike, the
 * line to look at, the last turns, the screen), and the page that tells the
 * whole story, with every step, every kept turn, and the screen at failure
 * inline. The `markdown` reporter writes one page per failed or flaky test
 * under `failures/` beside the report; the run page links each block to its
 * page. Both read the facts from here, so the two never disagree.
 */

import { isLoopbackHost } from '../internal/urls.ts';
import type { StepTurn } from '../run/steps.ts';
import type { Report1Document, ReportError, ReportResult, ReportSource, ReportStep } from './build.ts';
import { cell, code, formatDuration, link, MAX_CELL_CHARS, MAX_ID_CHARS, MAX_LABEL_CHARS, MAX_PATH_CHARS, MAX_TITLE_CHARS, plural } from './markdown-text.ts';
import { repeatSuffix } from './format.ts';
import type { AttemptView, Outcome } from './outcome.ts';

type ReportArtifact = ReportResult['attempts'][number]['artifacts'][number];

/** Prose fields (the agent's explanation, a detail value) get more room than a cell. */
export const MAX_DETAIL_CHARS = 600;
/** Turns shown under a failed agent step on the run page; the page shows every kept turn. */
const MAX_SUMMARY_TURNS = 3;
/** Screen text inlined in a page past this size is cut, and the page says so. */
const MAX_SCREEN_CHARS = 24_000;
/** Candidate nodes named on the run page; the page lists every one. */
const MAX_SUMMARY_CANDIDATES = 3;

export interface FailurePageOptions {
  /** A link to a source line, when the commit is known. */
  readonly sourceUrl?: ((file: string, line: number) => string) | undefined;
  /** Where the run's artifacts can be fetched; evidence links there. */
  readonly artifactsUrl?: string | undefined;
  /** The directory the report's artifact paths are relative to, as the reader should see it. */
  readonly artifactsDir?: string | undefined;
  /** Reads one artifact by its report path, for inlining the screen text; absent when the files are not at hand. */
  readonly readArtifact?: ((reportPath: string) => string | undefined) | undefined;
}

// --- facts shared with the run page ---

/**
 * The structured facts of an error, one per line: an assertion's expected,
 * its observed with the match count, what a locator asked for, how long it
 * waited. The locator as written is the step's label already.
 */
export function detailLines(error: ReportError | undefined): string[] {
  const details = error?.details;
  if (details === undefined) return [];
  const lines: string[] = [];
  const { expected, observed, matches, role, name, testId, waitedMs } = details;
  const matched = matches === undefined ? undefined : `${matches} ${matches === 1 ? 'match' : 'matches'}`;
  if (expected !== undefined) lines.push(`Expected: ${cell(expected, MAX_DETAIL_CHARS)}`);
  if (observed !== undefined) lines.push(`Observed: ${cell(observed, MAX_DETAIL_CHARS)}${matched === undefined ? '' : ` (${matched})`}`);
  else if (matched !== undefined) lines.push(`Matched: ${matched}`);
  const asked = [
    ...(role === undefined ? [] : [cell(role, MAX_ID_CHARS)]),
    ...(name === undefined ? [] : [`"${cell(name, MAX_LABEL_CHARS)}"`]),
    ...(testId === undefined ? [] : [`test id "${cell(testId, MAX_LABEL_CHARS)}"`]),
  ];
  if (asked.length > 0) lines.push(`Asked for: ${asked.join(' ')}`);
  if (waitedMs !== undefined && waitedMs > 0) lines.push(`Waited: ${formatDuration(waitedMs)}`);
  return lines;
}

/**
 * A step's label as the reader should see it: an agent step's is a sentence
 * the author wrote, quoted; any other step's is the locator or value it was
 * called with, which reads as code.
 */
export function stepLabel(step: ReportStep, max = MAX_LABEL_CHARS): string {
  return step.kind === 'agent' ? `"${cell(step.label, max)}"` : code(step.label, max);
}

/**
 * A loopback URL cannot be opened by anyone reading the page, so its path is
 * the whole of what it says; any other URL is kept whole.
 */
function screenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return isLoopbackHost(parsed.hostname) ? `${parsed.pathname}${parsed.search}${parsed.hash}` : url;
  } catch {
    return url;
  }
}

/** The attempt whose story a block tells: a flaky test's last failure, otherwise the final one. */
export function toldAttempt(result: ReportResult, final: Outcome): AttemptView {
  return result.status === 'flaky' ? (final.lastFailed ?? final.final) : final.final;
}

/** A step that did not pass. */
export type FailedStep = ReportStep & { readonly status: Exclude<ReportStep['status'], 'passed'> };

/** The step a failure happened at: the first that did not pass, with its position. */
export function failedStepOf(steps: readonly ReportStep[]): { index: number; step: FailedStep } | undefined {
  const index = steps.findIndex((step) => step.status !== 'passed');
  const step = steps[index];
  return step === undefined || step.status === 'passed' ? undefined : { index, step: step as FailedStep };
}

/**
 * How the attempts compare, when there was more than one: the same code at
 * the same step every time is a deterministic failure, not a flake, and the
 * reader should know before opening anything. One sentence, or nothing for a
 * single attempt.
 */
export function attemptsLine(result: ReportResult, final: Outcome): string | undefined {
  // An attempt that recorded nothing for this test (a serial group that never
  // reached the member) says nothing about how the test fails.
  const failed = final.attempts
    .filter((attempt) => attempt.status !== 'passed' && attempt.status !== 'skipped' && (attempt.error !== undefined || attempt.steps.length > 0))
    .map((attempt) => ({
      code: cell(attempt.error?.code ?? attempt.status, 128),
      step: failedStepOf(attempt.steps)?.index,
    }));
  const [first] = failed;
  if (first === undefined || final.attempts.length < 2 || failed.length < 2) return undefined;
  const where = (step: number | undefined): string => (step === undefined ? '' : ` at step ${step + 1}`);
  const count = failed.length === final.attempts.length ? (failed.length === 2 ? 'both attempts' : `all ${failed.length} attempts`) : plural(failed.length, 'attempt');
  if (failed.every((attempt) => attempt.code === first.code && attempt.step === first.step)) {
    return `Failed the same way on ${count}: **${first.code}**${where(first.step)}.${result.status === 'flaky' ? ' The retry that passed is the exception.' : ''}`;
  }
  return `Failed differently on ${count}: ${failed.map((attempt) => `**${attempt.code}**${where(attempt.step)}`).join(', then ')}.`;
}

/**
 * The line to look at: the one the failure unwound through when the stack
 * named it, else the failing step's own call, else the test's declaration.
 */
export function failureSource(result: ReportResult, told: AttemptView): ReportSource {
  const fromError = told.error?.source;
  if (fromError !== undefined) return fromError;
  const step = failedStepOf(told.steps)?.step;
  if (step !== undefined && step.source.file !== 'unknown') return step.source;
  return result.source;
}

/** `file:line`, linked to the commit when known, else in backticks. */
export function sourceText(source: ReportSource, sourceUrl: FailurePageOptions['sourceUrl']): string {
  const text = `${source.file}:${source.line}`;
  return sourceUrl === undefined ? code(text) : link(cell(text), sourceUrl(source.file, source.line));
}

/** One turn on one line: its calls, then the first line of what came back. */
function turnLine(turn: StepTurn, max = MAX_DETAIL_CHARS): string {
  const calls = turn.calls.length === 0 ? 'no tool call' : turn.calls.map((call) => code(call, MAX_LABEL_CHARS * 2)).join(', ');
  const outcome = turn.outcome.split('\n').find((line) => line.trim() !== '') ?? '';
  return `Turn ${turn.index}: ${calls}${outcome === '' ? '' : ` → ${cell(outcome, max)}`}`;
}

/** `Turn 4: tap(...) → ...`, one line per kept turn, the last few of a failed agent step, for the run page. */
export function lastTurnLines(step: ReportStep | undefined): string[] {
  // The verdict turn repeats the explanation the block already quotes.
  const turns = step?.turns?.filter((turn) => !(turn.calls.length > 0 && turn.calls.every((call) => call.startsWith('complete_step('))));
  if (turns === undefined) return [];
  return turns.slice(-MAX_SUMMARY_TURNS).map((turn) => turnLine(turn, 160));
}

/** `Screen: /path` and `Closest to the locator: ...`, for the run page. */
export function screenLines(told: AttemptView): string[] {
  const failure = told.failure;
  if (failure === undefined) return [];
  const lines: string[] = [];
  if (failure.url !== undefined) lines.push(`Screen: ${code(screenUrl(failure.url), MAX_PATH_CHARS)}`);
  const candidates = failure.candidates ?? [];
  if (candidates.length > 0) {
    const shown = candidates.slice(0, MAX_SUMMARY_CANDIDATES).map((line) => code(line, MAX_CELL_CHARS));
    if (candidates.length > shown.length) shown.push(`and ${candidates.length - shown.length} more`);
    lines.push(`Closest to the locator: ${shown.join(', ')}`);
  }
  return lines;
}

/** Artifacts of the told attempt by id, the failure's own first, one per kind. */
export function evidenceOf(told: AttemptView): ReportArtifact[] {
  const byId = new Map(told.artifacts.map((artifact) => [artifact.id, artifact]));
  const own = [told.failure?.screenshot, told.failure?.screen].flatMap((id) => (id === undefined ? [] : (byId.get(id) ?? [])));
  const seen = new Set(own.map((artifact) => artifact.id));
  const rest: ReportArtifact[] = [];
  const kinds = new Set<string>();
  for (const artifact of told.artifacts) {
    if (seen.has(artifact.id) || kinds.has(artifact.kind) || artifact.kind === 'log') continue;
    kinds.add(artifact.kind);
    rest.push(artifact);
  }
  return [...own, ...rest];
}

// --- the page ---

const STATUS_WORD: Record<ReportResult['status'], string> = {
  passed: 'passed',
  flaky: 'flaky',
  failed: 'failed',
  'timed-out': 'timed out',
  interrupted: 'interrupted',
  skipped: 'skipped',
};

const STEP_GLYPH: Record<ReportStep['status'], string> = { passed: '✓', failed: '✗', blocked: '✗', 'timed-out': '✗', cancelled: '–' };

/** `[screenshot](run#artifacts) \`web/.../screenshot-1.png\``: the kind, linked to the run's artifacts when there is a URL, and the file's path so the reader finds it. */
function artifactPath(artifact: ReportArtifact, options: FailurePageOptions): string {
  const kind = cell(artifact.kind, MAX_ID_CHARS);
  const named = options.artifactsUrl === undefined ? kind : link(kind, options.artifactsUrl);
  if (artifact.path === undefined) return named;
  const shown = options.artifactsDir === undefined ? artifact.path : `${options.artifactsDir}/${artifact.path}`;
  return `${named} ${code(shown, MAX_PATH_CHARS)}`;
}

/** Renders one failed or flaky result as its own markdown page. */
export function renderFailurePage(report: Report1Document, result: ReportResult, final: Outcome, options: FailurePageOptions = {}): string {
  const run = report.run;
  const told = toldAttempt(result, final);
  const manyTargets = run.targets.length > 1;
  const title = `${result.titlePath.map((part) => cell(part, MAX_TITLE_CHARS)).join(' › ')}${repeatSuffix(result.repeat)}`;
  const lines: string[] = [`# ✗ ${title}`, ''];
  const about = [
    code(result.file, MAX_PATH_CHARS),
    ...(manyTargets ? [`target ${code(result.targetId, MAX_ID_CHARS)}`] : []),
    ...(result.agent === 'default' ? [] : [`agent ${code(result.agent, MAX_ID_CHARS)}`]),
    STATUS_WORD[result.status],
    formatDuration(final.durationMs),
  ];
  lines.push(about.join(' · '), '');

  const error = told.error;
  if (error !== undefined) {
    const phase = error.phase === undefined || error.phase === 'body' ? '' : ` in ${cell(error.phase, MAX_ID_CHARS)}`;
    lines.push(`**${cell(error.code, 128)}**${phase}`, '', '```text', error.message.replaceAll('```', "'''"), '```', '');
    // An assertion's message already spells out expected and observed; the facts line would repeat the block above it.
    const { expected, observed } = error.details ?? {};
    const spelled = expected !== undefined && observed !== undefined && error.message.includes(expected) && error.message.includes(observed);
    if (!spelled) for (const line of detailLines(error)) lines.push(`${line}  `);
  } else {
    lines.push(`_${STATUS_WORD[result.status]}: no error was recorded._`);
  }
  lines.push(`Look at: ${sourceText(failureSource(result, told), options.sourceUrl)}  `);
  const attempts = attemptsLine(result, final);
  if (attempts !== undefined) lines.push(`${attempts}  `);
  if (result.status === 'flaky') lines.push(`Passed after ${plural(final.failedAttempts, 'failed attempt')}; this page tells the last failure.  `);
  lines.push('');

  const at = failedStepOf(told.steps);
  if (told.steps.length > 0) {
    lines.push('## Steps', '');
    told.steps.forEach((step, index) => {
      const own = step.source.file === 'unknown' ? '' : ` — ${code(`${step.source.file}:${step.source.line}`, MAX_PATH_CHARS)}`;
      const calls = step.metrics === undefined || step.metrics.modelCalls === 0 ? '' : `, ${plural(step.metrics.modelCalls, 'model call')}`;
      const failed = step.status === 'passed' ? '' : ` — **${cell(step.error?.code ?? step.status, 128)}**`;
      lines.push(`${index + 1}. ${STEP_GLYPH[step.status]} ${code(step.api, MAX_ID_CHARS)} ${stepLabel(step, MAX_CELL_CHARS)} (${formatDuration(step.durationMs)}${calls})${failed}${own}`);
      if (step.status !== 'passed' && step.explanation !== undefined && step.explanation.trim() !== '') {
        lines.push(`   > ${cell(step.explanation, MAX_DETAIL_CHARS)}`);
      }
    });
    lines.push('');
  }

  const turns = at?.step.turns;
  if (turns !== undefined && turns.length > 0) {
    lines.push(`## Agent turns of step ${at!.index + 1}`, '');
    lines.push(`The last ${plural(turns.length, 'turn')} the model took, oldest first: what it called and what came back.`, '');
    for (const turn of turns) {
      const calls = turn.calls.length === 0 ? '_no tool call_' : turn.calls.map((call) => code(call, MAX_CELL_CHARS)).join(', ');
      lines.push(`**Turn ${turn.index}** ${calls}  `);
      for (const line of turn.outcome.split('\n').slice(0, 12)) lines.push(`> ${cell(line, MAX_CELL_CHARS)}`);
      lines.push('');
    }
  }

  const failure = told.failure;
  if (failure !== undefined) {
    lines.push('## Screen at failure', '');
    if (failure.url !== undefined) lines.push(`URL: ${code(failure.url, MAX_PATH_CHARS)}  `);
    if (failure.candidates !== undefined && failure.candidates.length > 0) {
      lines.push('Closest to what the locator asked for:  ');
      for (const candidate of failure.candidates) lines.push(`- ${code(candidate, MAX_CELL_CHARS)}`);
    }
    const screen = failure.screen === undefined ? undefined : told.artifacts.find((artifact) => artifact.id === failure.screen);
    const text = screen?.path === undefined ? undefined : options.readArtifact?.(screen.path);
    if (text !== undefined) {
      const body = text.length > MAX_SCREEN_CHARS ? `${text.slice(0, MAX_SCREEN_CHARS)}\n…[cut at ${MAX_SCREEN_CHARS} characters; the file has the rest]` : text;
      lines.push('', 'The screen as the agent reads it, one node per line: `#id role "name" text="…" [states]`.', '', '```text', body.replaceAll('```', "'''").trimEnd(), '```');
    } else if (screen !== undefined) {
      lines.push(`Screen text: ${artifactPath(screen, options)}  `);
    }
    lines.push('');
  }

  const evidence = evidenceOf(told);
  if (evidence.length > 0) {
    lines.push('## Evidence', '');
    for (const artifact of evidence) lines.push(`- ${artifactPath(artifact, options)}`);
    lines.push('');
  }

  lines.push(`<sub>e2e ${cell(run.runner.version, MAX_ID_CHARS)} · run ${code(run.id, MAX_ID_CHARS)} · the whole run is in \`report.json\`</sub>`);
  return `${lines.join('\n')}\n`;
}
