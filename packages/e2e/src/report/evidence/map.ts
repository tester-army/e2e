/**
 * The run as an evidence pack, in memory: what each file of the `.evidence`
 * layout holds, read from the finished report-1 document. No I/O here;
 * `write.ts` puts the plan on disk.
 *
 * Evidence separates `failed`, the product was wrong, from `broken`, the
 * check could not decide. Only `ASSERTION_FAILED` says the product was wrong;
 * every other failure (an inconclusive judgment, a locator that matched
 * nothing, a timeout, an interrupt) is broken.
 */

import path from 'node:path';
import type { ArtifactRecord, FailureEvidence } from '../../run/records.ts';
import type { Report1Document, ReportError, ReportResult, ReportStep } from '../build.ts';

/** The evidence contract version this producer writes. */
const EVIDENCE_VERSION = '0.1';
/** The one error code that says the product, not the check, was wrong. */
const PRODUCT_DEFECT_CODES: ReadonlySet<string> = new Set(['ASSERTION_FAILED']);
/** Redaction levels whose files are safe to copy into a pack a reader may share. */
const SHAREABLE: ReadonlySet<string> = new Set(['complete', 'not-required']);
/** The definition file each test folder holds. */
const DEFINITION_FILE = 'test.json';

type Verdict = 'passed' | 'failed' | 'broken' | 'skipped';
type Json = Record<string, unknown>;

export interface PackPlan {
  /** `run.yaml`, with `status: running`; `finalize` closes it. */
  readonly run: Json;
  /** `coverage/e2e-summary.json`: the run's counts, usage, and limits. */
  readonly coverage: Json;
  readonly tests: readonly TestPlan[];
}

export interface TestPlan {
  /** The folder under `tests/`, also `result.yaml`'s `test`. */
  readonly dir: string;
  /**
   * The opaque definition the format hashes: the test's identity from the
   * report (id, title path, file, line, tags), written as `name`. Never the
   * test's source, which can hold a secret value as a plain string.
   */
  readonly definition: { readonly name: string; readonly content: string };
  readonly result: Json;
  readonly steps: readonly StepPlan[];
  readonly logs: readonly LogPlan[];
}

export interface StepPlan {
  /** `<ordinal>-<id>` under `steps/`. */
  readonly folder: string;
  /** `step.json`: the report's step record without its model turns. */
  readonly record: Json;
  /** The frame to copy as `screenshot.<ext>`, relative to the artifacts root. */
  readonly screenshot?: string;
  /** The failure's screen text to copy as `screen.txt`, relative to the artifacts root. */
  readonly screen?: string;
  /** `failure.yaml`, on the step a failure landed on. */
  readonly failure?: Json;
}

export interface LogPlan {
  readonly name: string;
  /** The file under `logs/`. */
  readonly file: string;
  readonly format: string;
  /** An artifact to copy, relative to the artifacts root; else `content` is written. */
  readonly source?: string;
  readonly content?: string;
}

/** What one result ran, wherever the report keeps it: its own last attempt, or its member record in a serial group's. */
interface Execution {
  readonly attemptIndex: number;
  readonly steps: readonly ReportStep[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly error: ReportError | undefined;
  readonly failure: FailureEvidence | undefined;
}

/** Plans the pack for a finished run: one test folder per selected result. */
export function planPack(report: Report1Document): PackPlan {
  const run = report.run;
  const selected = run.results.filter((result) => result.selected);
  const names = testNames(selected);
  const tests = selected.map((result, index) => planTest(report, result, names[index]!));
  return {
    run: {
      evidence: EVIDENCE_VERSION,
      run_id: run.id,
      status: 'running',
      started: run.startedAt,
      title: run.project.id,
      environment: runEnvironment(report),
      metrics: runMetrics(report),
    },
    coverage: { summary: run.summary, usage: run.usage, limits: run.limits },
    tests,
  };
}

/** `run.yaml`'s open environment block: the producer, platforms, host, CI, models, and commit. */
function runEnvironment(report: Report1Document): Json {
  const run = report.run;
  const models = new Set<string>();
  const steps = [
    ...run.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.steps)),
    // A serial member's steps live in its group's attempts, not its own result.
    ...run.serialGroups.flatMap((group) => group.attempts.flatMap((attempt) => attempt.members.flatMap((member) => member.steps))),
  ];
  for (const step of steps) if (step.model !== undefined) models.add(`${step.model.provider}/${step.model.model}`);
  return {
    producer: { name: run.runner.name, version: run.runner.version },
    surfaces: [...new Set(run.targets.map((target) => target.platform))],
    os: run.environment.os,
    arch: run.environment.arch,
    runtime: run.environment.runtime,
    ...(run.environment.ci ? { ci: { detected: true } } : {}),
    ...(models.size === 0 ? {} : { model: [...models].join(', ') }),
    ...(run.vcs === undefined ? {} : { vcs: run.vcs }),
  };
}

/** `run.yaml`'s typed metrics: facts, never verdicts. */
function runMetrics(report: Report1Document): Json {
  const { summary, usage } = report.run;
  return {
    tests_executed: { value: summary.executed, type: 'count' },
    model_tokens: { value: usage.modelTokens, type: 'count' },
    artifact_bytes: { value: usage.artifactBytes, type: 'bytes', unit: 'B' },
    ...(usage.estimatedCostUsd === undefined ? {} : { estimated_cost_usd: { value: usage.estimatedCostUsd, type: 'currency', unit: 'USD' } }),
  };
}

/** One selected result as a test folder. */
function planTest(report: Report1Document, result: ReportResult, name: string): TestPlan {
  const dir = testDir(result);
  const execution = executionOf(report, result);
  const artifacts = new Map((execution?.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const failingIndex = execution === undefined ? -1 : failingStepIndex(execution);
  const baseOrigin = report.run.targets.find((target) => target.id === result.targetId)?.baseOrigin;
  const steps = (execution?.steps ?? []).map((step) => planStep(step, execution!, artifacts, step.index === failingIndex, baseOrigin));
  const attempts = attemptsOf(report, result);
  return {
    dir,
    definition: { name: DEFINITION_FILE, content: `${JSON.stringify(definitionOf(result), null, 2)}\n` },
    result: {
      evidence: EVIDENCE_VERSION,
      test: dir,
      status: resultVerdict(result, execution),
      definition: { path: DEFINITION_FILE },
      // `session_name` is what the viewer lists the test as and heads it with.
      external_id: { session_name: name, e2e_test_id: result.testId, e2e_result_id: result.id, target: result.targetId, agent: result.agent, repeat: result.repeat },
      duration_ms: attempts.reduce((total, attempt) => total + attempt.duration_ms, 0),
      ...(attempts.length === 0 ? {} : { attempts }),
      ...(result.status === 'flaky' ? { flaky: true } : {}),
      ...(result.tags.length === 0 ? {} : { tags: result.tags }),
      ...testEnvironment(execution),
      steps: steps.map((entry) => entry.summary),
    },
    steps: steps.map((entry) => entry.plan),
    logs: logsFor(execution, artifacts),
  };
}

/** What the test is, from the report alone, whose titles and ids the runner already redacted. */
function definitionOf(result: ReportResult): Json {
  return { e2e_test_id: result.testId, title: result.titlePath, file: result.file, line: result.source.line, tags: result.tags };
}

/**
 * Each result's readable name: its title path, then whatever tells it apart
 * from a result with the same title (the target or the agent, when those
 * differ among them, and a repeat after the first).
 */
function testNames(results: readonly ReportResult[]): string[] {
  const byTitle = new Map<string, ReportResult[]>();
  for (const result of results) {
    const title = result.titlePath.join(' › ');
    byTitle.set(title, [...(byTitle.get(title) ?? []), result]);
  }
  return results.map((result) => {
    const title = result.titlePath.join(' › ');
    const same = byTitle.get(title) ?? [];
    const parts = [title];
    if (new Set(same.map((other) => other.targetId)).size > 1) parts.push(result.targetId);
    if (new Set(same.map((other) => other.agent)).size > 1 && result.agent !== 'default') parts.push(`agent ${result.agent}`);
    if (result.repeat > 0) parts.push(`repeat ${result.repeat + 1}`);
    return parts.join(' · ');
  });
}

/**
 * `t-<first 16 hex of the result id>`: generated, never from a title (a
 * label never becomes a path component), and distinct across targets,
 * agents, and repeats. The title is in `result.yaml`'s `external_id`.
 */
function testDir(result: ReportResult): string {
  return `t-${result.id.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 16)}`;
}

/** The viewport the test's CSS-pixel boxes are measured against, as `WxH`, when a step recorded one. */
function testEnvironment(execution: Execution | undefined): Json {
  const viewport = execution?.steps.find((step) => step.viewport !== undefined)?.viewport;
  return viewport === undefined ? {} : { environment: { resolution: `${viewport.width}x${viewport.height}` } };
}

/** What one result ran: its own last attempt, or its member record in its serial group's last attempt. */
function executionOf(report: Report1Document, result: ReportResult): Execution | undefined {
  if (result.serialGroupId !== undefined) {
    const attempt = report.run.serialGroups.find((group) => group.id === result.serialGroupId)?.attempts.at(-1);
    const member = attempt?.members.find((candidate) => candidate.testId === result.testId);
    if (attempt === undefined || member === undefined) return undefined;
    return { attemptIndex: attempt.index, steps: member.steps, artifacts: attempt.artifacts, error: member.error, failure: member.failure };
  }
  const attempt = result.attempts.at(-1);
  if (attempt === undefined) return undefined;
  return { attemptIndex: attempt.index, steps: attempt.steps, artifacts: attempt.artifacts, error: attempt.error, failure: attempt.failure };
}

/** Every attempt of a result: its own, or for a serial member its record in each of its group's attempts. */
function attemptsOf(report: Report1Document, result: ReportResult): { status: Verdict; duration_ms: number }[] {
  if (result.serialGroupId !== undefined) {
    const group = report.run.serialGroups.find((candidate) => candidate.id === result.serialGroupId);
    return (group?.attempts ?? []).flatMap((attempt) => {
      const member = attempt.members.find((candidate) => candidate.testId === result.testId);
      return member === undefined ? [] : [{ status: attemptVerdict(member.status, member.error), duration_ms: member.durationMs }];
    });
  }
  return result.attempts.map((attempt) => ({ status: attemptVerdict(attempt.status, attempt.error), duration_ms: attempt.durationMs }));
}

/** The step the failure landed on: the last one that did not pass. */
function failingStepIndex(execution: Execution): number {
  if (execution.error === undefined && execution.failure === undefined) return -1;
  return execution.steps.findLast((step) => step.status !== 'passed')?.index ?? -1;
}

/** `failed` for the one product-defect code, `broken` for anything else. */
function errorVerdict(error: ReportError | undefined): Verdict {
  return error !== undefined && PRODUCT_DEFECT_CODES.has(error.code) ? 'failed' : 'broken';
}

/** A result's verdict from its status and its final error. */
function resultVerdict(result: ReportResult, execution: Execution | undefined): Verdict {
  if (result.status === 'passed' || result.status === 'flaky') return 'passed';
  if (result.status === 'skipped') return 'skipped';
  return errorVerdict(execution?.error);
}

/** An attempt's verdict from its status and error. */
function attemptVerdict(status: string, error: ReportError | undefined): Verdict {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  return errorVerdict(error);
}

/** A step's verdict: only a failed step can be `failed`; blocked, timed out, or cancelled is `broken`. */
function stepVerdict(step: ReportStep): Verdict {
  if (step.status === 'passed') return 'passed';
  if (step.status === 'failed') return errorVerdict(step.error);
  return 'broken';
}

/** What the step claimed against what the app showed: a matcher's details, or an assertion's instruction against the judgment. */
function expectation(step: ReportStep, error: ReportError | undefined): { expected: string; actual: string } | undefined {
  if (step.api === 'agent.assert' && step.status !== 'passed' && step.explanation !== undefined) {
    return { expected: step.label, actual: step.explanation };
  }
  const details = error?.details as { expected?: unknown; observed?: unknown } | undefined;
  if (details?.expected === undefined) return undefined;
  return { expected: String(details.expected), actual: details.observed === undefined ? '' : String(details.observed) };
}

/** Whether an artifact is a local file whose redaction allows copying it into a pack. */
function shareable(artifact: ArtifactRecord | undefined): artifact is ArtifactRecord & { path: string } {
  return artifact !== undefined && artifact.path !== undefined && SHAREABLE.has(artifact.redaction);
}

/** One step as its folder, its `result.yaml` entry, and the failure record when the failure landed on it. */
function planStep(
  step: ReportStep,
  execution: Execution,
  artifacts: ReadonlyMap<string, ArtifactRecord>,
  failing: boolean,
  baseOrigin: string | undefined,
): { summary: Json; plan: StepPlan } {
  const id = `${execution.attemptIndex}-${step.index}`;
  const ordinal = step.index + 1;
  const folder = `${ordinal}-${id}`;
  const status = stepVerdict(step);
  const error = step.error ?? (failing ? execution.error : undefined);
  const claim = expectation(step, error);
  const summary: Json = {
    id,
    ordinal,
    status,
    kind: step.api,
    ...(step.label === '' ? {} : { label: step.label }),
    duration_ms: step.durationMs,
    ...(step.cache === undefined ? {} : { cache: step.cache.mode }),
    ...(claim === undefined || status === 'passed' ? {} : claim),
  };

  let screenshot = step.artifacts.map((artifactId) => artifacts.get(artifactId)).find((artifact) => artifact?.kind === 'screenshot' && shareable(artifact))?.path;
  let screen: string | undefined;
  let failure: Json | undefined;
  if (failing && error !== undefined) {
    const frame = execution.failure?.screenshot === undefined ? undefined : artifacts.get(execution.failure.screenshot);
    if (screenshot === undefined && shareable(frame)) screenshot = frame.path;
    const screenText = execution.failure?.screen === undefined ? undefined : artifacts.get(execution.failure.screen);
    if (shareable(screenText)) screen = screenText.path;
    const locator = (error.details as { locator?: unknown } | undefined)?.locator;
    const pageState: Json = {
      ...(execution.failure?.url === undefined ? {} : { url: execution.failure.url }),
      ...(screenshot === undefined ? {} : { screenshot: `steps/${folder}/screenshot${path.posix.extname(screenshot)}` }),
      ...(screen === undefined ? {} : { a11y: `steps/${folder}/screen.txt` }),
    };
    failure = {
      step: id,
      status: status === 'passed' ? errorVerdict(error) : status,
      title: step.label === '' ? step.api : step.label,
      error: { message: error.message, code: error.code },
      ...claim,
      ...(typeof locator === 'string' ? { locator_context: { locator } } : {}),
      ...(Object.keys(pageState).length === 0 ? {} : { page_state: pageState }),
    };
  }

  const { turns: _turns, ...record } = step;
  const url = failing && execution.failure?.url !== undefined ? execution.failure.url : openedUrl(step, baseOrigin);
  return {
    summary,
    plan: {
      folder,
      // The fields the evidence viewer reads, then the e2e record whole.
      record: {
        id,
        kind: step.api,
        status,
        summary: stepSummary(step),
        duration_ms: step.durationMs,
        ...(url === undefined ? {} : { url }),
        ...cursorOf(step),
        e2e: record,
      },
      ...(screenshot === undefined ? {} : { screenshot }),
      ...(screen === undefined ? {} : { screen }),
      ...(failure === undefined ? {} : { failure }),
    },
  };
}

/**
 * Where the viewer draws its cursor and the element outline, in CSS pixels:
 * the exact point of a positioned action, else the centre of the node's box.
 */
function cursorOf(step: ReportStep): Json {
  const { box, point } = step.target ?? {};
  const at = point ?? (box === undefined ? undefined : { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  return {
    ...(at === undefined ? {} : { coordinates: { x: Math.round(at.x), y: Math.round(at.y) } }),
    ...(box === undefined
      ? {}
      : { element_rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } }),
  };
}

/** The page an `app.open` step opened, from the target's origin; other steps have no URL the report knows. */
function openedUrl(step: ReportStep, baseOrigin: string | undefined): string | undefined {
  if (step.api !== 'app.open') return undefined;
  if (/^https?:\/\//.test(step.label)) return step.label;
  if (baseOrigin === undefined) return undefined;
  try {
    return new URL(step.label === '' ? '/' : step.label, baseOrigin).href;
  } catch {
    return undefined;
  }
}

const AGENT_VERBS: Readonly<Record<string, string>> = { 'agent.act': 'Act', 'agent.assert': 'Assert', 'agent.waitFor': 'Wait for', 'agent.extract': 'Extract' };
const APP_VERBS: Readonly<Record<string, string>> = { 'app.open': 'Open', 'app.back': 'Go back', 'app.restart': 'Restart the app', 'app.clearState': 'Clear the app state', 'app.screenshot': 'Screenshot' };
/** Agent actions a summary names before it trails off. */
const MAX_SUMMARY_ACTIONS = 3;

/** `doubleTap` as `double tap`, `toHaveURL` as `to have URL`: an acronym stays whole. */
function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .map((word) => (/^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase()))
    .join(' ');
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One sentence for what a step did, from its api, its target, and what it was given. */
function stepSummary(step: ReportStep): string {
  const { api, label, argument } = step;
  const agentVerb = AGENT_VERBS[api];
  if (agentVerb !== undefined) {
    const done = step.events.flatMap((event) => (event.kind === 'engine' && event.detail !== undefined ? [event.detail] : []));
    const shown = done.slice(0, MAX_SUMMARY_ACTIONS).join(', ') + (done.length > MAX_SUMMARY_ACTIONS ? ', …' : '');
    return `${agentVerb}: ${label}${shown === '' ? '' : ` (${shown})`}`;
  }
  const appVerb = APP_VERBS[api];
  if (appVerb !== undefined) return [appVerb, label].filter((part) => part !== '').join(' ');
  if (api.startsWith('expect.')) return expectationSummary(api, label, argument);
  if (api.startsWith('locator.')) {
    const verb = api.slice('locator.'.length);
    if (argument !== undefined) {
      if (verb === 'fill') return `Fill ${label} with ${argument}`;
      if (verb === 'pressSequentially') return `Type ${argument} into ${label}`;
      if (verb === 'press') return `Press ${argument} on ${label}`;
      if (verb === 'selectOption') return `Select ${argument} in ${label}`;
      if (verb === 'setInputFiles') return `Upload ${argument} to ${label}`;
    }
    return [capitalized(words(verb)), label, argument].filter((part) => part !== undefined && part !== '').join(' ');
  }
  // Any other api, an engine's own included: its verb in words, then what it acted on.
  const verb = api.slice(api.lastIndexOf('.') + 1);
  return [capitalized(words(verb)), label, argument].filter((part) => part !== undefined && part !== '').join(' ');
}

/** `Expect getByRole("alert") to have text "Saved"`, `Expect getByRole("dialog") not visible`. */
function expectationSummary(api: string, label: string, argument: string | undefined): string {
  const negated = api.startsWith('expect.not.');
  const matcher = api.replace(/^expect\.(not\.)?/, '');
  const not = negated ? 'not ' : '';
  if (argument !== undefined && matcher.startsWith('toBe')) return `Expect ${label} ${not}${argument}`;
  const phrase = words(matcher);
  const noun = phrase.replace(/^to (have|contain|match) /, '');
  if (argument === undefined) return `Expect ${not}${noun} ${label}`.trim();
  // `toHaveText` expecting `text "Saved"` reads once: `to have text "Saved"`.
  const value = argument.toLowerCase().startsWith(`${noun} `) ? argument.slice(noun.length + 1) : argument;
  return `Expect ${label} ${not}${phrase} ${value}`;
}

/** The step stream, the agent's turns when it took any, and every trace whose redaction allows sharing. */
function logsFor(execution: Execution | undefined, artifacts: ReadonlyMap<string, ArtifactRecord>): LogPlan[] {
  const steps = execution?.steps ?? [];
  const logs: LogPlan[] = [
    {
      name: 'steps',
      file: 'steps.ndjson',
      format: 'ndjson',
      content: lines(steps.map((step) => ({ index: step.index, api: step.api, label: step.label, status: step.status, events: step.events }))),
    },
  ];
  const turns = steps.filter((step) => step.turns !== undefined && step.turns.length > 0);
  if (turns.length > 0) {
    logs.push({
      name: 'agent',
      file: 'agent.ndjson',
      format: 'ndjson',
      content: lines(turns.map((step) => ({ index: step.index, api: step.api, label: step.label, turns: step.turns }))),
    });
  }
  const traces = [...artifacts.values()].filter((artifact) => artifact.kind === 'trace' && shareable(artifact));
  // Core knows no engine's trace format: the file keeps the extension the engine gave it.
  traces.forEach((trace, index) => {
    const name = index === 0 ? 'trace' : `trace-${index + 1}`;
    logs.push({ name, file: `${name}${path.posix.extname(trace.path!)}`, format: 'trace', source: trace.path! });
  });
  return logs;
}

/** Records as NDJSON text. */
function lines(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length === 0 ? '' : '\n');
}
