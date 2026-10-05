/**
 * A failed test as text: the facts the run page's failure block states (what
 * the error said in structured form, whether the attempts failed alike, the
 * line to look at, the last turns, the screen), and the page that tells the
 * whole story, with every step, every kept turn, and the screen at failure
 * inline. The runner writes one such page per test that kept a trace under
 * `traces/` beside the report; the run page links each block to its page. Both read the facts from here, so the two never disagree.
 */

import { isLoopbackHost } from '../internal/urls.ts';
import type { StepCacheInfo, StepCacheRecord, StepEvent, StepTurn } from '../run/steps.ts';
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

export interface TracePageOptions {
  /** A link to a source line, when the commit is known. */
  readonly sourceUrl?: ((file: string, line: number) => string) | undefined;
  /** Where the run's artifacts can be fetched; evidence links there. */
  readonly artifactsUrl?: string | undefined;
  /** The directory the report's artifact paths are relative to, as the reader should see it. */
  readonly artifactsDir?: string | undefined;
  /** Reads one artifact by its report path, for inlining the screen text; absent when the files are not at hand. */
  readonly readArtifact?: ((reportPath: string) => string | undefined) | undefined;
  /** The replay cache directory as the reader should see it; a step's entry is named as a file there. */
  readonly cacheDir?: string | undefined;
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
  if (step.label === '') return '';
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

/**
 * The attempt whose story a block tells: a flaky test's last failure; for a
 * failed or timed-out test, the last attempt that reached that verdict, so a
 * retry the run interrupted (or a serial member that retry never reached)
 * tells nothing; otherwise the final one.
 */
export function toldAttempt(result: ReportResult, final: Outcome): AttemptView {
  if (result.status === 'flaky') return final.lastFailed ?? final.final;
  if (result.status === 'failed' || result.status === 'timed-out') {
    return final.attempts.findLast((attempt) => attempt.status === 'failed' || attempt.status === 'timed-out') ?? final.final;
  }
  return final.final;
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
  // reached the member), or one the run interrupted, says nothing about how the test fails.
  const failed = final.attempts
    .filter((attempt) => attempt.status !== 'passed' && attempt.status !== 'skipped' && attempt.status !== 'interrupted' && (attempt.error !== undefined || attempt.steps.length > 0))
    .map((attempt) => ({
      code: cell(attempt.error?.code ?? attempt.status, 128),
      step: failedStepOf(attempt.steps)?.index,
    }));
  const [first] = failed;
  if (first === undefined || final.attempts.length < 2 || failed.length < 2) return undefined;
  const where = (step: number | undefined): string => (step === undefined ? '' : ` at step ${step + 1}`);
  const count = failed.length === final.attempts.length ? (failed.length === 2 ? 'both attempts' : `all ${failed.length} attempts`) : plural(failed.length, 'attempt');
  // Consecutive attempts that failed alike are one run: `at step 8, then at step 20 (3 times)`.
  const runs: { code: string; step: number | undefined; count: number }[] = [];
  for (const attempt of failed) {
    const last = runs.at(-1);
    if (last !== undefined && last.code === attempt.code && last.step === attempt.step) last.count += 1;
    else runs.push({ ...attempt, count: 1 });
  }
  if (runs.length === 1) {
    return `Failed the same way on ${count}: **${first.code}**${where(first.step)}.${result.status === 'flaky' ? ' The retry that passed is the exception.' : ''}`;
  }
  const told = runs.map((run, index) => {
    const named = index === 0 || run.code !== runs[index - 1]?.code;
    const place = `${named ? `**${run.code}**` : ''}${where(run.step)}`.trimStart();
    return run.count === 1 ? place : `${place} (${run.count} times)`;
  });
  return `Failed on ${count}: ${told.join(', then ')}.`;
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
export function sourceText(source: ReportSource, sourceUrl: TracePageOptions['sourceUrl']): string {
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

/** Result lines of one turn a page quotes; the loop's own notes are quoted past them. */
const MAX_TURN_LINES = 12;
/** How the agent loop marks a note it wrote onto a turn: a loop guard, a wind-down, a retry. */
const LOOP_NOTE_PREFIX = '[loop] ';

/** A turn's outcome as the page quotes it: the first result lines, then every loop note, which come last and say why the step ended. */
function turnOutcomeLines(outcome: string): string[] {
  const lines = outcome.split('\n');
  const notes = lines.filter((line) => line.startsWith(LOOP_NOTE_PREFIX));
  const results = lines.filter((line) => !line.startsWith(LOOP_NOTE_PREFIX));
  return [...results.slice(0, MAX_TURN_LINES), ...(results.length > MAX_TURN_LINES ? ['…'] : []), ...notes];
}

// --- what each step did ---

/** Events a page lists under one step before saying how many more there were. */
const MAX_STEP_EVENTS = 20;

/** Why a step's replay missed or handed off, in words. */
const CACHE_REASON_TEXT: Readonly<Record<NonNullable<StepCacheInfo['reason']>, string>> = {
  retry: 'a retry never replays',
  'no-entry': 'nothing recorded for this step yet',
  'invalid-entry': 'the entry could not be read',
  truncated: 'the recording is incomplete',
  'wrong-context': 'the recording started on another screen',
  gap: 'the recording reached an action it cannot replay',
  'target-not-found': 'a recorded target is not on the screen',
  'target-ambiguous': 'a recorded target matches several nodes',
  'viewport-changed': 'the viewport changed size',
  'action-failed': 'a recorded action failed',
  'action-uncertain': 'a recorded action may or may not have landed',
  'end-mismatch': 'the recorded end state did not show',
};

/** What became of a step's recording, in words. */
const CACHE_WRITE_TEXT: Readonly<Record<NonNullable<StepCacheRecord['write']>, string>> = {
  saved: 'recording saved',
  kept: 'recording kept',
  unconfirmed: 'recording not saved: no check passed after this step',
  evicted: 'recording deleted',
  'no-change': 'nothing recorded: the step changed nothing a replay could check',
};

/** Where an app log line came from, as the page names it. */
const APP_SOURCE_TEXT: Readonly<Record<string, string>> = {
  console: 'console',
  error: 'uncaught',
  network: 'network',
  system: 'system',
};

/**
 * The lines under one step on the page, oldest first: the cache's decision
 * for an agent step, then each action it took (the node it landed on), each
 * poll that waited or failed (the values it read in order), and every line
 * the app logged while it ran.
 */
function stepDetailLines(step: ReportStep, options: Pick<TracePageOptions, 'cacheDir'> = {}): string[] {
  const lines: string[] = [];
  if (step.cache !== undefined) lines.push(cacheLine(step.cache, options.cacheDir));
  const told = step.events
    .filter((event) => event.kind === 'app' || event.kind === 'engine' || (event.kind === 'poll' && ((event.count ?? 0) > 1 || event.status !== 'passed')))
    .toSorted((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const shown = closestToTheEnd(told);
  if (shown.length < told.length) lines.push(`${told.length - shown.length} earlier ${told.length - shown.length === 1 ? 'event' : 'events'} left out`);
  for (const event of shown) lines.push(eventLine(event));
  return lines;
}

/**
 * The events a page lists for a step with more than it has room for: every
 * one that failed or logged an error, then the latest of the rest, in the
 * order they happened. The end of a step is where it went wrong.
 */
function closestToTheEnd(events: readonly StepEvent[]): readonly StepEvent[] {
  if (events.length <= MAX_STEP_EVENTS) return events;
  const kept = new Set(events.filter((event) => event.status !== 'passed').slice(-MAX_STEP_EVENTS));
  for (const event of events.toReversed()) {
    if (kept.size >= MAX_STEP_EVENTS) break;
    kept.add(event);
  }
  return events.filter((event) => kept.has(event));
}

function cacheLine(cache: StepCacheRecord, cacheDir: string | undefined): string {
  const how =
    cache.mode === 'self-finalized'
      ? `replayed all ${plural(cache.totalActions, 'recorded action')}, no model call`
      : cache.mode === 'agent-concluded'
        ? `replayed ${cache.replayedActions} of ${plural(cache.totalActions, 'recorded action')}, then the agent took over: ${CACHE_REASON_TEXT[cache.reason ?? 'action-failed']}`
        : `no replay: ${CACHE_REASON_TEXT[cache.reason ?? 'no-entry']}`;
  const parts = [
    `cache: ${how}`,
    ...(cache.detail === undefined ? [] : [cell(cache.detail, MAX_DETAIL_CHARS)]),
    ...(cache.write === undefined ? [] : [CACHE_WRITE_TEXT[cache.write]]),
    ...(cache.notRecorded === 'param-collision' ? ['nothing recorded: a unique() value collides with another param'] : []),
  ];
  const entry = cache.entry === undefined || cacheDir === undefined ? '' : ` (${code(`${cacheDir}/${cache.entry}.json`, MAX_PATH_CHARS)})`;
  return `${parts.join('; ')}${entry}`;
}

function eventLine(event: StepEvent): string {
  const detail = event.detail === undefined ? undefined : cell(shortenLoopback(event.detail), MAX_DETAIL_CHARS);
  switch (event.kind) {
    case 'app': {
      const glyph = event.level === 'error' ? '✗' : event.level === 'warning' ? '⚠' : 'ℹ';
      const text = event.detail === undefined ? '' : code(shortenLoopback(event.detail), MAX_DETAIL_CHARS);
      return `${glyph} ${APP_SOURCE_TEXT[event.name ?? ''] ?? cell(event.name ?? 'app', MAX_ID_CHARS)} ${event.level ?? 'info'}: ${text}`;
    }
    case 'poll': {
      const verb = event.status === 'passed' ? 'passed after' : 'gave up after';
      return `${event.name === undefined ? 'poll' : cell(event.name, MAX_ID_CHARS)} ${verb} ${plural(event.count ?? 1, 'read')} in ${formatDuration(event.durationMs)}${detail === undefined ? '' : `: ${detail}`}`;
    }
    default: {
      const what = detail ?? cell(event.name ?? event.kind, MAX_ID_CHARS);
      if (event.status === 'passed') return `${what} (${formatDuration(event.durationMs)})`;
      return `${event.status === 'cancelled' ? '–' : '✗'} ${what}${event.code === undefined ? '' : `: **${cell(event.code, 128)}**`}`;
    }
  }
}

/** Drops a loopback origin from the URLs in a line: nobody reading the page can open it, and the path says the rest. */
function shortenLoopback(text: string): string {
  return text.replaceAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?=\/)/g, '');
}

/**
 * `, video 0:12`: where the step starts in the recording that was running
 * then, the last segment that began before it. An attempt cut into several
 * segments (a restart opens a new page) names the segment too:
 * `, video-part2 0:03`. Nothing without a recording.
 */
function videoOffset(step: ReportStep, videos: readonly ReportArtifact[]): string {
  const at = Date.parse(step.startedAt);
  const video = videos.findLast((candidate) => Date.parse(candidate.startedAt!) <= at) ?? videos[0];
  if (video === undefined) return '';
  const seconds = Math.max(0, Math.floor((at - Date.parse(video.startedAt!)) / 1000));
  const name = videos.length > 1 && video.path !== undefined ? (video.path.split('/').at(-1) ?? 'video').replace(/\.[^.]+$/u, '') : 'video';
  return `, ${name} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
function artifactPath(artifact: ReportArtifact, options: TracePageOptions): string {
  const kind = cell(artifact.kind, MAX_ID_CHARS);
  // A video a hosted service keeps is its own link, wherever the run's files are.
  if (artifact.url !== undefined) return link(kind, artifact.url);
  const named = options.artifactsUrl === undefined ? kind : link(kind, options.artifactsUrl);
  if (artifact.path === undefined) return named;
  const shown = options.artifactsDir === undefined ? artifact.path : `${options.artifactsDir}/${artifact.path}`;
  return `${named} ${code(shown, MAX_PATH_CHARS)}`;
}

/** Renders one traced result as its own markdown page: a failed or flaky one tells its failure, a passing one its steps. */
export function renderTracePage(report: Report1Document, result: ReportResult, final: Outcome, options: TracePageOptions = {}): string {
  const run = report.run;
  const told = toldAttempt(result, final);
  const manyTargets = run.targets.length > 1;
  const title = `${result.titlePath.map((part) => cell(part, MAX_TITLE_CHARS)).join(' › ')}${repeatSuffix(result.repeat)}`;
  const lines: string[] = [`# ${result.status === 'passed' ? '✓' : '✗'} ${title}`, ''];
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
  } else if (result.status !== 'passed') {
    lines.push(`_${STATUS_WORD[result.status]}: no error was recorded._`);
  }
  if (result.status !== 'passed') lines.push(`Look at: ${sourceText(failureSource(result, told), options.sourceUrl)}  `);
  const attempts = attemptsLine(result, final);
  if (attempts !== undefined) lines.push(`${attempts}  `);
  if (result.status === 'flaky') lines.push(`Passed after ${plural(final.failedAttempts, 'failed attempt')}; this page tells the last failure.  `);
  if (lines.at(-1) !== '') lines.push('');

  const at = failedStepOf(told.steps);
  if (told.steps.length > 0) {
    const videos = told.artifacts
      .filter((artifact) => artifact.kind === 'video' && artifact.startedAt !== undefined)
      .toSorted((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
    lines.push('## Steps', '');
    told.steps.forEach((step, index) => {
      const own = step.source.file === 'unknown' ? '' : ` — ${code(`${step.source.file}:${step.source.line}`, MAX_PATH_CHARS)}`;
      const calls = step.metrics === undefined || step.metrics.modelCalls === 0 ? '' : `, ${plural(step.metrics.modelCalls, 'model call')}`;
      const failed = step.status === 'passed' ? '' : ` — **${cell(step.error?.code ?? step.status, 128)}**`;
      const offset = videoOffset(step, videos);
      const hook = step.phase === undefined ? '' : ` in ${step.phase}`;
      const label = stepLabel(step, MAX_CELL_CHARS);
      lines.push(`${index + 1}. ${STEP_GLYPH[step.status]} ${code(step.api, MAX_ID_CHARS)}${label === '' ? '' : ` ${label}`} (${formatDuration(step.durationMs)}${calls}${offset}${hook})${failed}${own}`);
      if (step.status !== 'passed' && step.explanation !== undefined && step.explanation.trim() !== '') {
        lines.push(`   > ${cell(step.explanation, MAX_DETAIL_CHARS)}`);
      }
      for (const line of stepDetailLines(step, options)) lines.push(`   - ${line}`);
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
      for (const line of turnOutcomeLines(turn.outcome)) lines.push(`> ${cell(line, MAX_CELL_CHARS)}`);
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

  if (told.secondaryErrors.length > 0) {
    lines.push('## Also failed', '');
    for (const secondary of told.secondaryErrors) {
      const phase = secondary.phase === undefined ? '' : ` in ${cell(secondary.phase, MAX_ID_CHARS)}`;
      lines.push(`- **${cell(secondary.code, 128)}**${phase}: ${cell(secondary.message, MAX_DETAIL_CHARS)}`);
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
