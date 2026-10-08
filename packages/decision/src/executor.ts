import type { LanguageModel } from 'ai';
import type { ExecutorObservation, StepExecutor, StepExecutorContext, StepTurn, StepVerdict } from 'e2e';
import { isAgentError } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import { decide, requireDecide, type Decision } from './decide.ts';
import { perform, type Action, type Argument } from './dispatch.ts';
import { actionSpace, type ActionSpace, type Control, type Operation, type Target } from './elements.ts';
import { PointLocator } from './locator.ts';
import type { Screenshot } from './overlay.ts';
import { describe, gated, invalid, need, pick, type Gates } from './picks.ts';
import {
  assertionRequest,
  completionRequest,
  elementRecords,
  operationRequest,
  nonSecretParams,
  targetRequest,
  type DecisionRequest,
  type HistoryEntry,
} from './questions.ts';
import { fieldText, pointTarget, uploadPaths, type FieldInput } from './text.ts';
import type { DecisionExecutorOptions } from './types.ts';
/** Error codes the runtime owns: rethrown untouched, never absorbed as history. */
const RUNTIME_CODES = new Set(['STEP_BUDGET_EXHAUSTED', 'STEP_TIMEOUT', 'CANCELLED']);
/** The handle in the runner's secret-fill summary: `fill secret "<json string>"` at the start. */
const SECRET_FILL = /^fill secret "(?:[^"\\]|\\.)*"/;
/** Builds a step executor that acts through a decision model and an optional text model. */
export function decisionExecutor(options: DecisionExecutorOptions): StepExecutor {
  if (typeof options !== 'object' || options === null) {
    throw new ConfigurationError('INVALID_CONFIG', `decisionExecutor() takes an options object; ${EXAMPLE}`);
  }
  requireDecide();
  checkModel(options.model);
  const gates: Gates = { minProbability: options.minProbability ?? 0, minConfidence: options.minConfidence ?? 0 };
  if (!inUnit(gates.minProbability) || !inUnit(gates.minConfidence)) {
    throw new ConfigurationError('INVALID_CONFIG', 'decisionExecutor({ minProbability, minConfidence }) must be between 0 and 1');
  }
  if (options.providerOptions !== undefined && !isOptionsRecord(options.providerOptions)) {
    throw new ConfigurationError('INVALID_CONFIG', 'decisionExecutor({ providerOptions }) maps provider names to option objects, e.g. { gateway: { zeroDataRetention: true } }');
  }
  if (options.vision !== undefined && typeof options.vision !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'decisionExecutor({ vision }) must be a boolean');
  }
  const textModel = options.textModel;
  return {
    name: 'decision',
    version: '2',
    cache: 'inherit',
    ...(textModel === undefined ? {} : { model: textModel }),
    ...(options.vision === true ? { vision: true } : {}),
    async runStep(ctx) {
      return new Step(ctx, options, gates).run();
    },
  };
}
/** How a valid model reads, for every model error. */
const EXAMPLE = "pass an AI SDK decision model, e.g. decisionExecutor({ model: typeSafeAi.decisionModel('jev-latest') })";
/**
 * Rejects anything the AI SDK cannot decide with, at config load: a model id
 * string, a language model, or a decision model that cannot answer `choice`.
 */
function checkModel(model: unknown): void {
  if (typeof model === 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `decisionExecutor({ model }) got a function, not a model; call it with a model id, ${EXAMPLE}`);
  }
  if (typeof model !== 'object' || model === null) {
    const got = typeof model === 'string' ? `the string ${JSON.stringify(model)}` : String(model);
    throw new ConfigurationError('INVALID_CONFIG', `decisionExecutor({ model }) got ${got}; ${EXAMPLE}`);
  }
  const fields = model as Record<string, unknown>;
  const name = `${String(fields['provider'])}/${String(fields['modelId'])}`;
  if (typeof fields['doDecide'] !== 'function' && typeof fields['doEvaluate'] !== 'function') {
    const kind = typeof fields['doGenerate'] === 'function' ? `the language model ${name}` : 'an object that is not a decision model';
    throw new ConfigurationError('INVALID_CONFIG', `decisionExecutor({ model }) got ${kind}; ${EXAMPLE}`);
  }
  if (fields['specificationVersion'] !== 'v4') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `decisionExecutor({ model }) got ${name}, a ${String(fields['specificationVersion'])} model; the AI SDK decides with v4 decision models`,
    );
  }
  const supported = fields['supportedQuestionTypes'];
  if (!Array.isArray(supported) || !supported.includes('choice')) {
    throw new ConfigurationError('INVALID_CONFIG', `decisionExecutor({ model }) got ${name}, which does not answer choice questions`);
  }
}
/** A plain object whose every value is a plain object: the shape the AI SDK takes as providerOptions. */
function isOptionsRecord(value: unknown): boolean {
  const isRecord = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null) return false;
    const prototype: unknown = Object.getPrototypeOf(v);
    return prototype === Object.prototype || prototype === null;
  };
  return isRecord(value) && Object.values(value as object).every(isRecord);
}
function inUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
/** One look at the app: the observation, its action space when complete, and the pixels the step may show. */
interface View {
  readonly path: string;
  readonly space: ActionSpace | undefined;
  readonly screenshot: Screenshot | undefined;
}
/** What the loop settled an operation into: an action to perform, a verdict to finish with, or a turn to skip with a note. */
type Next =
  | { readonly action: Action; readonly label: string; readonly targetAnswer?: Decision; readonly typed?: string }
  | { readonly verdict: StepVerdict }
  | { readonly skip: string; readonly because: string };
/**
 * One `agent.act` or `agent.assert` step: the loop, the budget, the history
 * the model reads, and the turns and transcript the runner keeps.
 */
class Step {
  private calls = 0;
  private readonly turns: StepTurn[] = [];
  private readonly transcript: string[] = [];
  private readonly history: HistoryEntry[];
  private readonly language: Exclude<LanguageModel, string> | undefined;
  private readonly canType: boolean;
  private readonly vision: boolean;
  private readonly scores: boolean;
  private readonly locator: PointLocator;
  private previousFingerprint: string | undefined;
  private lastTurn: StepTurn | undefined;
  private rejectedTerminals = 0;
  private attached = false;
  constructor(
    private readonly ctx: StepExecutorContext,
    private readonly options: DecisionExecutorOptions,
    private readonly gates: Gates,
  ) {
    this.history = seedHistory(ctx);
    this.language = ctx.model as Exclude<LanguageModel, string> | undefined;
    this.canType = this.language !== undefined && ctx.target.verbs.has('type');
    this.vision = options.vision === true;
    this.scores = options.model.supportedQuestionTypes.includes('score');
    this.locator = new PointLocator(ctx, (request) => this.ask(request), gates);
  }
  async run(): Promise<StepVerdict> {
    try {
      return await (this.ctx.step.kind === 'assert' ? this.judge() : this.act());
    } finally {
      // A thrown step keeps its evidence too: the transcript is what explains a refusal or a bad answer.
      this.attach();
    }
  }
  /** Whether this step may show pixels: vision is on and no secret has been filled in the attempt. */
  private get pixelsAllowed(): boolean {
    return this.vision && !this.ctx.pixelsTainted;
  }
  /** A fresh look: the tree, and masked pixels when allowed. `typing` keeps a filled field's row for verdict views. */
  private async view(typing: boolean): Promise<View> {
    const observation = await this.ctx.observe({ tree: true, pixels: this.pixelsAllowed });
    const path = observation.path ?? '';
    const pixels = this.pixelsAllowed ? observation.pixels : undefined;
    const screenshot = pixels === undefined ? undefined : { mediaType: pixels.mediaType, data: pixels.data, width: pixels.width, height: pixels.height, scale: pixels.scale };
    const tree = observation.tree;
    const space =
      observation.treeUnavailable || tree === undefined || emptyTree(observation)
        ? undefined
        : actionSpace(this.ctx, { path, viewport: observation.viewport, tree, ...(pixels === undefined ? {} : { pixels, scores: this.scores }) }, typing);
    return { path, space, screenshot };
  }
  /** One decide call under the step budget, or undefined once it is spent. */
  private async ask(request: DecisionRequest): Promise<Record<string, Decision> | undefined> {
    if (!this.spend()) return undefined;
    this.transcript.push(transcriptLine(request));
    const answers = await decide(this.ctx, this.options.model, request, this.options.providerOptions);
    this.transcript.push(JSON.stringify(answers));
    return answers;
  }
  /** One text-model call under the step budget, or undefined once it is spent. */
  private async askText<T>(call: (model: Exclude<LanguageModel, string>, input: FieldInput) => Promise<T>, what: string, page: string, field?: FieldInput['field']): Promise<T | undefined> {
    if (this.language === undefined) throw invalid(`The decision model chose ${what} with no text model configured.`);
    if (!this.spend()) return undefined;
    return call(this.language, {
      goal: this.ctx.step.instruction,
      context: this.ctx.agentContext ?? null,
      params: nonSecretParams(this.ctx.step.params),
      ...(field === undefined ? {} : { field }),
      page,
      recentActions: this.history.slice(-TEXT_HISTORY),
    });
  }
  private spend(): boolean {
    if (this.calls >= this.ctx.budgets.maxModelCalls) return false;
    this.calls += 1;
    return true;
  }
  private budgetMessage(): string {
    return `The step did not conclude within its ${this.ctx.budgets.maxModelCalls} decision calls.`;
  }
  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.ctx.attachTurns(this.turns);
    this.ctx.attachTranscript(this.transcript.join('\n'));
  }
  /** An assertion: one verdict on the current screen. */
  private async judge(): Promise<StepVerdict> {
    const { path, space, screenshot } = await this.view(true);
    // `vision: 'only'` judges the pixels alone, tree or no tree; without granted pixels the tree still decides.
    const pixelsOnly = this.ctx.step.vision === 'only' && screenshot !== undefined;
    if (space === undefined && !pixelsOnly) return inconclusive('A complete semantic observation is required.');
    const seen = pixelsOnly || space === undefined ? undefined : space;
    const answers = await this.ask(assertionRequest({
      goal: this.ctx.step.instruction,
      path,
      pageText: seen?.pageText ?? '',
      elements: seen === undefined ? [] : elementRecords(seen),
      statuses: seen?.statuses ?? [],
      ...(screenshot === undefined ? {} : { screenshot }),
    }));
    if (answers === undefined) return blocked(this.budgetMessage());
    const verdict = need(answers.verdict, 'verdict');
    const evidence = describe(verdict);
    const settled = gated(verdict, this.gates) ? verdict.choice : 'below gate';
    if (settled === 'holds') return { status: 'passed', summary: `The screen shows the assertion holds (${evidence}).` };
    if (settled === 'fails') return { status: 'failed', errorCode: 'ASSERTION_FAILED', summary: `The screen contradicts the assertion (${evidence}).` };
    return inconclusive(`The screen does not settle the assertion (${evidence}).`);
  }
  /** The act loop: observe, decide, perform, until a terminal claim is confirmed or the step cannot go on. */
  private async act(): Promise<StepVerdict> {
    for (;;) {
      const view = await this.view(this.canType);
      const { space, screenshot, path } = view;
      if (space === undefined) return blocked('A complete semantic observation is required.');
      const changed = space.fingerprint !== this.previousFingerprint;
      if (this.lastTurn !== undefined) {
        this.lastTurn.outcome += changed ? ', page changed' : ', page unchanged';
        this.lastTurn = undefined;
      }
      const previous = this.history.at(-1);
      if (previous !== undefined) this.history[this.history.length - 1] = { ...previous, pageChanged: changed };
      this.locator.settle(screenshot);
      this.previousFingerprint = space.fingerprint;
      if (stalled(this.history)) return blocked('Three actions in a row changed nothing on screen.');
      const decided = await this.ask(operationRequest(this.ctx, space, this.history, path));
      if (decided === undefined) return blocked(this.budgetMessage());
      const op = need(decided.operation, 'operation');
      if (!gated(op, this.gates)) return blocked(`The next operation is uncertain (${describe(op)}).`);
      if (op.choice === 'blocked') return blocked('The decision model cannot make progress.');
      if (op.choice === 'done' || op.choice === 'failed') {
        const terminal = await this.terminalCheck(op.choice);
        if (terminal !== undefined) return terminal;
        continue;
      }
      const next = await this.prepare(op, view);
      if ('verdict' in next) return next.verdict;
      if ('skip' in next) {
        this.history.push({ action: next.skip, error: next.because });
        continue;
      }
      await this.dispatch(next, op);
    }
  }
  /**
   * Turns the chosen operation into an action: a control as is, a point
   * through the locator, anything else through its target question and
   * the argument it needs.
   */
  private async prepare(op: Decision, view: View): Promise<Next> {
    const { space, screenshot, path } = view;
    if (space === undefined) throw new Error('prepare() needs a complete view');
    if (space.controls.has(op.choice as Control)) {
      const control = op.choice as Control;
      return { action: { operation: control }, label: CONTROL_LABELS[control] };
    }
    if (op.choice === 'tap_at') {
      if (space.grid === undefined || screenshot === undefined) throw invalid('The decision model chose tap_at with no grid offered.');
      const wanted = this.language === undefined ? undefined : await this.askText((model, input) => pointTarget(this.ctx, model, input), 'tap_at', space.pageText);
      if (wanted === undefined && this.language !== undefined) return { verdict: blocked(this.budgetMessage()) };
      const point = this.locator.known(path, wanted) ?? (await this.locator.locate(screenshot, path, wanted));
      if (point === undefined) return { verdict: blocked(this.budgetMessage()) };
      if ('uncertain' in point) return { verdict: blocked(`The tap point is uncertain (${point.uncertain}).`) };
      this.locator.tapped(path, wanted, point, screenshot);
      const label = wanted === undefined ? `tap at (${point.x}, ${point.y})` : `tap ${wanted} at (${point.x}, ${point.y})`;
      const target: Target = { id: '', description: label };
      return { action: { operation: 'tap_at', target, argument: { kind: 'point', point } }, label };
    }
    const operation = op.choice as Operation;
    const group = space.targets.get(operation);
    if (group === undefined) throw invalid('The decision model chose an unavailable operation.');
    // The target depends on the operation: its own request, after the operation settled.
    const request = targetRequest(this.ctx, space, operation, this.history, path);
    const answers = Object.keys(request.questions).length === 0 ? {} : await this.ask(request);
    if (answers === undefined) return { verdict: blocked(this.budgetMessage()) };
    const chosen = group.size === 1 ? only(group) : pick(answers.target, entries(group), 'target');
    if ('none' in chosen) return { verdict: blocked(`The decision model chose ${operation} but no target for it (${describe(chosen.none)}).`) };
    if (chosen.answer !== undefined && !gated(chosen.answer, this.gates)) return { verdict: blocked(`The next target is uncertain (${describe(chosen.answer)}).`) };
    const [key, target] = chosen.value;
    const field = (): FieldInput['field'] => {
      const element = space.element(key);
      return element === undefined ? { label: key, role: 'textbox' } : { label: element.label, role: element.role, ...(element.value === undefined ? {} : { value: element.value }) };
    };
    const act = (argument: Argument, typed?: string): Next => ({
      action: { operation, target, argument },
      label: callLabel(space, key, operation, target, typed),
      ...(chosen.answer === undefined ? {} : { targetAnswer: chosen.answer }),
      ...(typed === undefined ? {} : { typed }),
    });
    switch (operation) {
      case 'type': {
        const text = await this.askText((model, input) => fieldText(this.ctx, model, input), 'type', space.pageText, field());
        if (text === undefined) return { verdict: blocked(this.budgetMessage()) };
        if (text === null || text === '') return { skip: target.description, because: 'no value for this field' };
        return act({ kind: 'text', text }, text);
      }
      case 'upload': {
        const paths = await this.askText((model, input) => uploadPaths(this.ctx, model, input), 'upload', space.pageText, field());
        if (paths === undefined) return { verdict: blocked(this.budgetMessage()) };
        if (paths.length === 0) return { skip: target.description, because: 'no files for this input' };
        return act({ kind: 'paths', paths }, paths.join(', '));
      }
      case 'drag': {
        const destination = pick(answers.destination, space.destinations, 'drop destination');
        if ('none' in destination) return { verdict: blocked(`The decision model chose drag but no destination for it (${describe(destination.none)}).`) };
        if (!gated(destination.answer, this.gates)) return { verdict: blocked(`The drop destination is uncertain (${describe(destination.answer)}).`) };
        if (destination.value.id === target.id) return { verdict: blocked('The decision model chose to drag an element onto itself.') };
        return act({ kind: 'destination', id: destination.value.id }, `onto ${destination.value.label}`);
      }
      case 'typeSecret': {
        const secrets = this.ctx.step.secrets;
        if (secrets.length === 1 && secrets[0] !== undefined) return act({ kind: 'secret', name: secrets[0].name });
        const secret = pick(answers.secret, new Map(secrets.map((entry) => [entry.name, entry])), 'secret');
        if ('none' in secret) return { verdict: blocked(`The decision model chose typeSecret but no secret for it (${describe(secret.none)}).`) };
        if (!gated(secret.answer, this.gates)) return { verdict: blocked(`The next secret is uncertain (${describe(secret.answer)}).`) };
        return act({ kind: 'secret', name: secret.value.name });
      }
      default:
        return act({ kind: 'none' });
    }
  }
  /**
   * Performs an action and records the turn and the history entry. Action
   * failures go back to the model as history; only the runtime's own stop
   * codes propagate.
   */
  private async dispatch(next: { readonly action: Action; readonly label: string; readonly targetAnswer?: Decision; readonly typed?: string }, op: Decision): Promise<void> {
    const { action, label, targetAnswer, typed } = next;
    const targetPart = targetAnswer === undefined ? '' : `, target p=${targetAnswer.probability.toFixed(3)}`;
    const turn: StepTurn = { index: this.turns.length + 1, calls: [label], outcome: `op p=${op.probability.toFixed(3)}${targetPart}` };
    this.turns.push(turn);
    this.lastTurn = turn;
    const description = 'target' in action ? action.target.description : CONTROL_LABELS[action.operation];
    const entry: HistoryEntry = { action: description, ...(typed === undefined ? {} : { text: typed }) };
    try {
      const note = await perform(this.ctx, action);
      this.history.push(note === undefined ? entry : { ...entry, note });
    } catch (error) {
      if (isAgentError(error) && RUNTIME_CODES.has(error.code)) throw error;
      const code = isAgentError(error) ? error.code : error instanceof Error ? error.name : 'unknown';
      this.history.push({ ...entry, error: code });
    }
  }
  /**
   * Verifies a done/failed claim on a fresh screen with the actions taken so
   * far, but no model reasoning. Returns a verdict, or undefined to continue
   * the loop. A verdict under the gates confirms nothing.
   */
  private async terminalCheck(claim: 'done' | 'failed'): Promise<StepVerdict | undefined> {
    const { path, space, screenshot } = await this.view(true);
    if (space === undefined) return this.rejectClaim(claim, 'incomplete observation');
    const answers = await this.ask(completionRequest({
      goal: this.ctx.step.instruction,
      params: nonSecretParams(this.ctx.step.params),
      path,
      pageText: space.pageText,
      elements: elementRecords(space),
      history: this.history,
      statuses: space.statuses,
      ...(screenshot === undefined ? {} : { screenshot }),
    }));
    if (answers === undefined) return blocked(this.budgetMessage());
    const verdict = need(answers.verdict, 'verdict');
    const settled = gated(verdict, this.gates) ? verdict.choice : 'below gate';
    if (claim === 'done' && settled === 'holds') return { status: 'passed', summary: `The screen shows the step is done (${describe(verdict)}).` };
    if (claim === 'failed' && settled === 'fails') {
      return { status: 'failed', errorCode: 'ACTION_FAILED', summary: `The screen shows the step failed (${describe(verdict)}).` };
    }
    return this.rejectClaim(claim, settled);
  }
  /**
   * Records a rejected terminal claim and continues the loop. The second
   * rejected claim in a step ends it, decided by the check: visible
   * counter-evidence is a product failure, anything else an automation limit.
   */
  private rejectClaim(claim: 'done' | 'failed', check: string): StepVerdict | undefined {
    this.rejectedTerminals += 1;
    this.history.push({ action: claim, error: `check: ${check}` });
    if (this.rejectedTerminals < 2) return undefined;
    if (check === 'fails') {
      return { status: 'failed', errorCode: 'ACTION_FAILED', summary: `The screen contradicts the ${claim} claim.` };
    }
    return blocked(`The screen does not confirm the ${claim} claim (check: ${check}).`);
  }
}
/** Recent actions the text model sees: the whole step, so a ten-digit code is ten taps it can count. */
const TEXT_HISTORY = 60;
/** How a control reads in a turn and in history. */
const CONTROL_LABELS: Readonly<Record<Control, string>> = {
  scroll_up: 'scroll viewport up',
  scroll_down: 'scroll viewport down',
  back: 'back one step in history',
};
/** The lone entry of a one-target group dispatches with no question. */
function only<T>(group: ReadonlyMap<string, T>): { value: [string, T]; answer: undefined } {
  const entry = group.entries().next();
  if (entry.done === true) throw invalid('The decision model chose an unavailable target.');
  return { value: entry.value, answer: undefined };
}
/** A group keyed the way `pick` resolves it: by key, to the key and its target. */
function entries<T>(group: ReadonlyMap<string, T>): ReadonlyMap<string, [string, T]> {
  return new Map([...group].map(([key, value]) => [key, [key, value]]));
}
/** One turn call label, e.g. type [3] textbox "New todo" = "Buy milk". */
function callLabel(space: ActionSpace, key: string, operation: Operation, target: Target, text?: string): string {
  const element = space.element(key);
  if (element === undefined) return target.description;
  const value = text === undefined ? '' : ` = ${JSON.stringify(text)}`;
  return `${operation} [${element.index}] ${element.role} ${JSON.stringify(element.label)}${value}`;
}
/** One transcript line: the request without its pixels, which are named by size. */
function transcriptLine(request: DecisionRequest): string {
  const { screenshot, ...rest } = request;
  return JSON.stringify(screenshot === undefined ? rest : { ...rest, screenshot: `${screenshot.width}x${screenshot.height}` });
}
/**
 * Seeds history from a replayed prefix, flagging the uncertain action. The
 * runner's summaries name a filled secret's handle (`fill secret "admin.password"
 * into ...`, cut at 40 characters); secret names reach the model only as
 * `secret` question criteria, so that handle becomes `<secret>`. Labels and
 * values elsewhere in a summary stay as they are, even when they match a name.
 */
function seedHistory(ctx: StepExecutorContext): HistoryEntry[] {
  const prefix = ctx.replayedPrefix;
  if (prefix === undefined) return [];
  const redact = (summary: string): string => summary.replace(SECRET_FILL, 'fill secret <secret>');
  const seeded: HistoryEntry[] = prefix.replayedActions.map((action) => ({ action: redact(action), replayed: true as const }));
  if (prefix.uncertainAction !== undefined) {
    seeded.push({ action: redact(prefix.uncertainAction), replayed: true, uncertain: true });
  }
  return seeded;
}
/** Three recorded actions in a row with no page change. */
function stalled(history: readonly HistoryEntry[]): boolean {
  if (history.length < 3) return false;
  return history.slice(-3).every((entry) => entry.pageChanged === false);
}
/** No nodes to build an action space from. A truncated observation still acts on what is there. */
function emptyTree(observation: ExecutorObservation): boolean {
  const tree = observation.tree;
  return tree === undefined || ((tree.children ?? []).length === 0 && observation.text.trim() === '');
}
/** An automation limitation says nothing about the application correctness. */
function blocked(summary: string): StepVerdict {
  return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary };
}
/** Insufficient evidence must never become an assertion pass. */
function inconclusive(summary: string): StepVerdict {
  return { status: 'failed', errorCode: 'ASSERTION_INCONCLUSIVE', summary };
}
