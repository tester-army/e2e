import { formatDuration, testTitle, type Artifact, type AttemptView, type ReportError, type ReportModel, type Result, type Step } from './data.ts';

/** Agent turns quoted per failed step; the trace page has every one. */
const MAX_TURNS = 3;
/** App errors quoted; the trace page has the whole log. */
const MAX_APP_ERRORS = 10;

/**
 * The text "copy prompt" puts on the clipboard: one failed attempt as a
 * coding agent reads it, with the files to open for the rest. The agent runs
 * in the project, so file paths are from the project root.
 */
export function failurePrompt(model: ReportModel, result: Result, attempt: AttemptView, position: { readonly number: number; readonly count: number }): string {
  const sections = [
    section('Instructions', [
      '- This end-to-end test failed. Explain why, briefly.',
      '- Then suggest a fix to the test or to the app, with code where you can.',
      '- Read the test file and the files listed below before answering: the trace has every step, action, and screen.',
    ]),
    section('Test', [
      `- Name: ${testTitle(result)}`,
      `- File: ${result.source.file}:${result.source.line}`,
      `- Target: ${result.targetId}`,
      `- Attempt: ${position.number} of ${position.count} (${attempt.status})`,
    ]),
    section('Error', attempt.error === undefined ? [] : errorLines(attempt.error)),
    section(
      'Also failed',
      attempt.secondaryErrors.flatMap((error) => errorLines(error)),
    ),
    section(
      'Steps',
      attempt.steps.flatMap((step, index) => stepLines(step, index, attempt)),
    ),
    section('At failure', failureLines(attempt)),
    section(
      'App errors',
      attempt.appLog
        .filter((line) => line.level === 'error')
        .slice(0, MAX_APP_ERRORS)
        .map((line) => `- ${line.text}`),
    ),
    section('Files (from the project root)', fileLines(model, result, attempt)),
  ];
  return `${sections.filter((text) => text !== '').join('\n\n')}\n`;
}

/** A Markdown section, or nothing when it has no lines. */
function section(title: string, lines: readonly string[]): string {
  return lines.length === 0 ? '' : [`# ${title}`, ...lines].join('\n');
}

function errorLines(error: ReportError): string[] {
  const where = error.source === undefined ? '' : ` at ${error.source.file}:${error.source.line}`;
  // Longer than any backtick run in the message, so the message cannot close it.
  const fence = '`'.repeat(Math.max(3, ...(error.message.match(/`+/gu) ?? []).map((run) => run.length + 1)));
  return [`${error.code}${where}`, fence, error.message, fence];
}

/** One line per step; a step that did not pass also gets what it did and why it stopped. */
function stepLines(step: Step, index: number, attempt: AttemptView): string[] {
  const label = step.label === '' ? '' : `: ${step.label.replaceAll('\n', ' ')}`;
  const notes = [formatDuration(step.durationMs), step.phase, step.cache === undefined ? undefined : `cache ${step.cache.mode}`].filter((note) => note !== undefined);
  const head = `${index + 1}. ${step.status} ${step.api}${label} (${notes.join(', ')})`;
  if (step.status === 'passed') return [head];
  const actions = step.events.flatMap((event) => (event.kind === 'engine' && event.detail !== undefined ? [`${event.detail}${event.status === 'passed' ? '' : ` (${event.status})`}`] : []));
  const turns = (step.turns ?? []).slice(-MAX_TURNS).map((turn) => `turn ${turn.index}: ${turn.calls.join(', ')} -> ${turn.outcome}`);
  // The attempt's own error is quoted above; a step's differing error is new.
  const error = step.error === undefined || step.error.message === attempt.error?.message ? undefined : `${step.error.code}: ${step.error.message}`;
  return [
    head,
    ...[
      step.explanation === undefined ? undefined : `explanation: ${step.explanation}`,
      error === undefined ? undefined : `error: ${error}`,
      ...actions.map((action) => `action: ${action}`),
      ...turns,
    ]
      .filter((line) => line !== undefined)
      .map((line) => `   ${line.replaceAll('\n', '\n   ')}`),
  ];
}

function failureLines(attempt: AttemptView): string[] {
  const { failure } = attempt;
  if (failure === undefined) return [];
  return [
    ...(failure.url === undefined ? [] : [`- Screen: ${failure.url}`]),
    ...(failure.candidates === undefined || failure.candidates.length === 0 ? [] : ['- Closest on screen:', ...failure.candidates.map((line) => `  - ${line}`)]),
  ];
}

/** The trace page, the failure evidence, the videos, and the files the test left; the step screenshots are in the trace. */
function fileLines(model: ReportModel, result: Result, attempt: AttemptView): string[] {
  const trace = Object.hasOwn(model.traces, result.id) ? model.traces[result.id] : undefined;
  const describe = (artifact: Artifact): string | undefined => {
    if (artifact.id === attempt.failure?.screen) return 'the screen tree at the failure';
    if (artifact.id === attempt.failure?.screenshot) return 'a screenshot at the failure';
    if (artifact.kind === 'video') return 'the recording';
    return artifact.kind === 'screenshot' ? undefined : artifact.kind;
  };
  const files = attempt.artifacts.flatMap((artifact) => {
    const about = describe(artifact);
    return about === undefined || artifact.path === undefined ? [] : [`- ${model.resultsDir}/${artifact.path}: ${about}`];
  });
  return [...(trace === undefined ? [] : [`- ${trace}: the runner's trace of this test`]), ...files];
}
