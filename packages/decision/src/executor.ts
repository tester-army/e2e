import type { LanguageModel } from 'ai';
import type { ExecutorObservation, StepExecutor, StepExecutorContext, StepTurn, StepVerdict } from 'e2e';
import { AgentError, isAgentError } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import { decide, requireDecide, type Decision } from './decide.ts';
import { actionSpace, type ActionSpace, type Control, type Grid, type Operation, type Target } from './elements.ts';
import {
  NONE,
  assertionRequest,
  completionRequest,
  elementRecords,
  operationRequest,
  nonSecretParams,
  pointRequest,
  targetKeyIndex,
  targetRequest,
  type DecisionRequest,
  type HistoryEntry,
  type Screenshot,
} from './questions.ts';
import { gridCells, withGrid, zoomAround } from './overlay.ts';
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
  const minProbability = options.minProbability ?? 0;
  const minConfidence = options.minConfidence ?? 0;
  if (!inUnit(minProbability) || !inUnit(minConfidence)) {
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
      return run(ctx, options, minProbability, minConfidence);
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
/** An action the loop dispatched, still open to its outcome suffix. */
interface Taken {
  readonly target: Target;
  readonly operation: string;
  readonly elementKey: string;
}
/** What a target question settled: a bound target, or the model's `none` for the chosen operation. */
type Resolved = { readonly taken: Taken; readonly targetAnswer?: Decision } | { readonly none: Decision };
async function run(
  ctx: StepExecutorContext,
  options: DecisionExecutorOptions,
  minProbability: number,
  minConfidence: number,
): Promise<StepVerdict> {
  const model = options.model;
  let calls = 0;
  const turns: StepTurn[] = [];
  const transcript: string[] = [];
  const history: HistoryEntry[] = seedHistory(ctx);
  const language = ctx.model as Exclude<LanguageModel, string> | undefined;
  const canType = language !== undefined && ctx.target.verbs.has('type');
  const vision = options.vision === true;
  /** Whether the model scores ordered levels, which is how a `tap_at` is located. */
  const scores = supportsScores(model);
  /** Whether this step may show pixels: vision is on and no secret has been filled in the attempt. */
  const pixelsAllowed = (): boolean => vision && !ctx.pixelsTainted;
  let previousFingerprint: string | undefined;
  let lastTurn: StepTurn | undefined;
  let rejectedTerminals = 0;
  let attached = false;
  const attach = (): void => {
    if (attached) return;
    attached = true;
    ctx.attachTurns(turns);
    ctx.attachTranscript(transcript.join('\n'));
  };
  const finish = (verdict: StepVerdict): StepVerdict => {
    attach();
    return verdict;
  };
  const gated = (decision: Decision): boolean =>
    decision.probability >= minProbability && decision.confidence >= minConfidence;
  const describe = (decision: Decision): string =>
    `p=${decision.probability.toFixed(3)}, confidence ${decision.confidence.toFixed(3)}`;
  const budgetMessage = (): string =>
    `The step did not conclude within its ${ctx.budgets.maxModelCalls} decision calls.`;
  /** A fresh observation: the tree, and masked pixels when vision is on and no secret has been filled. */
  const look = (): Promise<ExecutorObservation> => ctx.observe({ tree: true, pixels: pixelsAllowed() });
  /** The granted pixels of an observation as the model receives them; nothing without vision. */
  const screenshotOf = (observation: ExecutorObservation): Screenshot | undefined => {
    const pixels = pixelsAllowed() ? observation.pixels : undefined;
    if (pixels === undefined) return undefined;
    return { mediaType: pixels.mediaType, data: pixels.data, width: pixels.width, height: pixels.height, scale: pixels.scale };
  };
  /**
   * The action space of a complete observation; undefined when the tree is
   * missing or empty. Verdict views pass `typing: true` so a field the step
   * filled keeps its row and value even when the step itself cannot type.
   */
  const spaceOf = (observation: ExecutorObservation, typing: boolean): ActionSpace | undefined => {
    const tree = observation.tree;
    if (observation.treeUnavailable || tree === undefined || emptyTree(observation)) return undefined;
    const pixels = pixelsAllowed() ? observation.pixels : undefined;
    return actionSpace(
      ctx,
      { path: observation.path ?? '', viewport: observation.viewport, tree, ...(pixels === undefined ? {} : { pixels, scores }) },
      typing,
    );
  };
  const ask = async (request: DecisionRequest): Promise<Record<string, Decision> | undefined> => {
    if (calls >= ctx.budgets.maxModelCalls) return undefined;
    transcript.push(JSON.stringify({ state: request.state, questions: request.questions, ...(request.screenshot === undefined ? {} : { screenshot: `${request.screenshot.width}x${request.screenshot.height}` }) }));
    calls += 1;
    const answers = await decide(ctx, model, request, options.providerOptions);
    transcript.push(JSON.stringify(answers));
    return answers;
  };
  const textInput = (field: FieldInput['field'], page: string): FieldInput => ({
    goal: ctx.step.instruction,
    context: ctx.agentContext ?? null,
    params: nonSecretParams(ctx.step.params),
    field,
    page,
    recentActions: history.slice(-6),
  });
  const askText = async (field: FieldInput['field'], page: string): Promise<string | null | undefined> => {
    if (calls >= ctx.budgets.maxModelCalls) return undefined;
    if (language === undefined) throw invalid('The decision model chose type with no text model configured.');
    calls += 1;
    return fieldText(ctx, language, textInput(field, page));
  };
  /** The drawn control to tap next, from the text model; the goal itself without one. */
  const askPointTarget = async (page: string): Promise<string | undefined> => {
    if (language === undefined) return undefined;
    if (calls >= ctx.budgets.maxModelCalls) return undefined;
    calls += 1;
    const { field: _field, ...input } = textInput({ label: '', role: '' }, page);
    // The whole step so far, not the last few turns: a ten-digit code is ten taps the model must count.
    return pointTarget(ctx, language, { ...input, recentActions: history.slice(-POINT_HISTORY) });
  };
  /** Points that landed, by the control the text model named: the same key again needs no new looks. */
  const landed = new Map<string, { x: number; y: number }>();
  /** The last point tap, settled against the next observation: a page change means it landed. */
  let lastPoint: { wanted: string; point: { x: number; y: number } } | undefined;
  const askPaths = async (field: FieldInput['field'], page: string): Promise<readonly string[] | undefined> => {
    if (calls >= ctx.budgets.maxModelCalls) return undefined;
    if (language === undefined) throw invalid('The decision model chose upload with no text model configured.');
    calls += 1;
    return uploadPaths(ctx, language, textInput(field, page));
  };
  try {
    return await loop();
  } finally {
    // A thrown step keeps its evidence too: the transcript is what explains a refusal or a bad answer.
    attach();
  }
  async function loop(): Promise<StepVerdict> {
  if (ctx.step.kind === 'assert') {
    const observation = await look();
    const space = spaceOf(observation, true);
    const screenshot = screenshotOf(observation);
    // `vision: 'only'` judges the pixels alone, tree or no tree; without granted pixels the tree still decides.
    const pixelsOnly = ctx.step.vision === 'only' && screenshot !== undefined;
    if (space === undefined && !pixelsOnly) return finish(inconclusive('A complete semantic observation is required.'));
    const request = assertionRequest(
      ctx.step.instruction,
      observation.path ?? '',
      pixelsOnly || space === undefined ? '' : space.pageText,
      pixelsOnly || space === undefined ? [] : elementRecords(space),
      screenshot,
      pixelsOnly || space === undefined ? [] : space.statuses,
    );
    const answers = await ask(request);
    if (answers === undefined) return finish(blocked(budgetMessage()));
    const verdict = need(answers.verdict, 'verdict');
    const evidence = describe(verdict);
    if (gated(verdict) && verdict.choice === 'holds') {
      return finish({ status: 'passed', summary: `The screen shows the assertion holds (${evidence}).` });
    }
    if (gated(verdict) && verdict.choice === 'fails') {
      const summary = `The screen contradicts the assertion (${evidence}).`;
      return finish({ status: 'failed', errorCode: 'ASSERTION_FAILED', summary });
    }
    return finish(inconclusive(`The screen does not settle the assertion (${evidence}).`));
  }
  for (;;) {
    const observation = await look();
    const space = spaceOf(observation, canType);
    if (space === undefined) return finish(blocked('A complete semantic observation is required.'));
    const changed = space.fingerprint !== previousFingerprint;
    if (lastTurn !== undefined) {
      lastTurn.outcome += changed ? ', page changed' : ', page unchanged';
      lastTurn = undefined;
    }
    const previous = history.at(-1);
    if (previous !== undefined) history[history.length - 1] = { ...previous, pageChanged: changed };
    if (lastPoint !== undefined) {
      if (changed) landed.set(lastPoint.wanted, lastPoint.point);
      else landed.delete(lastPoint.wanted);
      lastPoint = undefined;
    }
    previousFingerprint = space.fingerprint;
    if (stalled(history)) return finish(blocked('Three actions in a row changed nothing on screen.'));
    const screenshot = screenshotOf(observation);
    // The operation and target questions read the tree: measured on gpt-6-luna, a
    // screenshot beside the element table flips a hover target from the card
    // menu to the card. The pixels serve the point looks and the verdicts.
    const decided = await ask(operationRequest(ctx, space, history, observation.path ?? ''));
    if (decided === undefined) return finish(blocked(budgetMessage()));
    const op = need(decided.operation, 'operation');
    if (!gated(op)) return finish(blocked(`The next operation is uncertain (${describe(op)}).`));
    if (op.choice === 'blocked') return finish(blocked('The decision model cannot make progress.'));
    if (op.choice === 'done' || op.choice === 'failed') {
      const terminal = await terminalCheck(op.choice);
      if (terminal !== undefined) return finish(terminal);
      continue;
    }
    if (op.choice === 'tap_at') {
      const grid = space.grid;
      if (grid === undefined || screenshot === undefined) throw invalid('The decision model chose tap_at with no grid offered.');
      const wanted = await askPointTarget(space.pageText);
      const known = wanted === undefined ? undefined : landed.get(wanted);
      const point = known ?? (await locate(grid, screenshot, observation.path ?? '', wanted));
      if (point === undefined) return finish(blocked(budgetMessage()));
      if ('uncertain' in point) return finish(blocked(`The tap point is uncertain (${point.uncertain}).`));
      const label = wanted === undefined ? `tap at (${point.x}, ${point.y})` : `tap ${wanted} at (${point.x}, ${point.y})`;
      const target: Target = { description: label, run: () => grid.tapAt(point) };
      await runTarget({ target, operation: 'tap_at', elementKey: '' }, op, undefined, space);
      if (wanted !== undefined) lastPoint = { wanted, point };
      continue;
    }
    // The target depends on the operation: its own request, after the operation settled.
    const targeted = targetRequest(ctx, space, op.choice as Operation, history, observation.path ?? '');
    const answers = Object.keys(targeted.questions).length === 0 ? {} : await ask(targeted);
    if (answers === undefined) return finish(blocked(budgetMessage()));
    const resolved = resolveTarget(op.choice, answers, space);
    if ('none' in resolved) {
      return finish(blocked(`The decision model chose ${op.choice} but no target for it (${describe(resolved.none)}).`));
    }
    const { taken, targetAnswer } = resolved;
    if (targetAnswer !== undefined && !gated(targetAnswer)) {
      return finish(blocked(`The next target is uncertain (${describe(targetAnswer)}).`));
    }
    if (op.choice === 'type') {
      const text = await askText(elementField(space, taken.elementKey), space.pageText);
      if (text === undefined) return finish(blocked(budgetMessage()));
      if (text === null || text === '') {
        history.push({ action: taken.target.description, error: 'no value for this field' });
        continue;
      }
      await runTarget(taken, op, targetAnswer, space, text, text);
      continue;
    }
    if (op.choice === 'upload') {
      const paths = await askPaths(elementField(space, taken.elementKey), space.pageText);
      if (paths === undefined) return finish(blocked(budgetMessage()));
      if (paths.length === 0) {
        history.push({ action: taken.target.description, error: 'no files for this input' });
        continue;
      }
      await runTarget(taken, op, targetAnswer, space, paths, paths.join(', '));
      continue;
    }
    if (op.choice === 'drag') {
      const destination = resolveDestination(answers.destination, space);
      if ('none' in destination) {
        return finish(blocked(`The decision model chose drag but no destination for it (${describe(destination.none)}).`));
      }
      if (!gated(destination.answer)) return finish(blocked(`The drop destination is uncertain (${describe(destination.answer)}).`));
      if (destination.key === taken.elementKey) return finish(blocked('The decision model chose to drag an element onto itself.'));
      await runTarget(taken, op, targetAnswer, space, destination.key, `onto ${destination.label}`);
      continue;
    }
    let secret: string | undefined;
    if (op.choice === 'typeSecret') {
      const chosen = resolveSecret(answers.secret);
      if ('none' in chosen) {
        return finish(blocked(`The decision model chose typeSecret but no secret for it (${describe(chosen.none)}).`));
      }
      if (chosen.answer !== undefined && !gated(chosen.answer)) {
        return finish(blocked(`The next secret is uncertain (${describe(chosen.answer)}).`));
      }
      secret = chosen.name;
    }
    await runTarget(taken, op, targetAnswer, space, secret);
  }
  }
  /**
   * Locates a drawn control in two looks: the column and row on the plain
   * full screenshot, then again on a zoomed crop around that point with a
   * grid drawn on it. Measured on gpt-6-luna over the drawn keypad: a grid
   * on the full screenshot pulls the first look a column left, and the
   * second look lands within 45px of every key where the first alone
   * misses by a key.
   */
  async function locate(
    grid: Grid,
    screenshot: Screenshot,
    path: string,
    wanted: string | undefined,
  ): Promise<{ x: number; y: number } | { uncertain: string } | undefined> {
    const coarse = await ask(pointRequest(ctx, path, screenshot, { ...grid, framing: 'This image is the full screenshot; no grid is drawn on it.' }, wanted));
    if (coarse === undefined) return undefined;
    const first = scored(coarse);
    if ('uncertain' in first) return first;
    let point = pointOf(grid.columns * grid.cellWidth, grid.rows * grid.cellHeight, grid.cellWidth, grid.cellHeight, first.x, first.y);
    for (const box of ZOOM_BOXES) {
      const zoom = zoomAround(screenshot, point, box, ZOOM_FACTOR);
      if (zoom === undefined) return point;
      const side = zoom.screenshot.width;
      const cell = side / ZOOM_CELLS;
      const image = withGrid(zoom.screenshot, gridCells(side, side, ZOOM_CELLS, ZOOM_CELLS));
      const framing = `This image is a ${ZOOM_FACTOR}x zoom of a ${Math.round(side / ZOOM_FACTOR)} by ${Math.round(side / ZOOM_FACTOR)} pixel region of the screen.`;
      const fine = await ask(pointRequest(ctx, path, image, { columns: ZOOM_CELLS, rows: ZOOM_CELLS, cellWidth: cell, cellHeight: cell, framing }, wanted));
      if (fine === undefined) return undefined;
      const next = scored(fine);
      if ('uncertain' in next) return next;
      const inZoom = pointOf(side, side, cell, cell, next.x, next.y);
      point = { x: Math.round(zoom.origin.x + inZoom.x / zoom.factor), y: Math.round(zoom.origin.y + inZoom.y / zoom.factor) };
    }
    return point;
  }
  /** The column and row scores of a point request, gated like any answer. */
  function scored(answers: Record<string, Decision>): { x: number; y: number } | { uncertain: string } {
    const x = need(answers.x, 'x');
    const y = need(answers.y, 'y');
    if (!gated(x) || !gated(y)) return { uncertain: `x ${describe(x)}; y ${describe(y)}` };
    return { x: x.score ?? Number(x.choice), y: y.score ?? Number(y.choice) };
  }
  /**
   * Resolves the chosen operation to a bound target, or to the model's
   * `none` for it. Throws MODEL_OUTPUT_INVALID for anything not offered.
   */
  function resolveTarget(choice: string, answers: Record<string, Decision>, space: ActionSpace): Resolved {
    const control = space.controls.get(choice as Control);
    if (control !== undefined) return { taken: { target: control, operation: choice, elementKey: '' } };
    const group = space.targets.get(choice as Operation);
    if (group === undefined) throw invalid('The decision model chose an unavailable operation.');
    if (group.size === 1) {
      const only = group.entries().next();
      if (only.done === true) throw invalid('The decision model chose an unavailable target.');
      return { taken: { target: only.value[1], operation: choice, elementKey: only.value[0] } };
    }
    const answer = answers.target;
    if (answer === undefined) throw invalid('The decision model returned no target answer.');
    if (answer.choice === NONE) return { none: answer };
    const target = group.get(answer.choice);
    if (target === undefined) throw invalid('The decision model chose an unavailable target.');
    return { taken: { target, operation: choice, elementKey: answer.choice }, targetAnswer: answer };
  }
  /** Resolves the drop destination of a drag: the only one, or the gated destination answer. */
  function resolveDestination(
    answer: Decision | undefined,
    space: ActionSpace,
  ): { key: string; label: string; answer: Decision } | { none: Decision } {
    if (answer === undefined) throw invalid('The decision model returned no drag destination.');
    if (answer.choice === NONE) return { none: answer };
    const destination = space.destinations.get(answer.choice);
    if (destination === undefined) throw invalid('The decision model chose an unavailable drop destination.');
    return { key: answer.choice, label: destination.label, answer };
  }
  /** Resolves the secret fill: the declared secret, or the gated secret answer with 2+ secrets. */
  function resolveSecret(answer: Decision | undefined): { name: string; answer?: Decision } | { none: Decision } {
    const secrets = ctx.step.secrets;
    if (secrets.length === 1 && secrets[0] !== undefined) return { name: secrets[0].name };
    if (answer === undefined) throw invalid('The decision model returned no secret answer.');
    if (answer.choice === NONE) return { none: answer };
    const found = secrets.find((secret) => secret.name === answer.choice);
    if (found === undefined) throw invalid('The decision model chose an undeclared secret.');
    return { name: found.name, answer };
  }
  /**
   * Dispatches a bound target and records the turn and the history entry.
   * Action failures go back to the model as history; only the runtime's own
   * stop codes propagate.
   */
  async function runTarget(
    taken: Taken,
    op: Decision,
    targetAnswer: Decision | undefined,
    space: ActionSpace,
    argument?: string | readonly string[],
    typedText?: string,
  ): Promise<void> {
    const targetPart = targetAnswer === undefined ? '' : `, target p=${targetAnswer.probability.toFixed(3)}`;
    const turn: StepTurn = {
      index: turns.length + 1,
      calls: [callLabel(space, taken, op.choice, typedText)],
      outcome: `op p=${op.probability.toFixed(3)}${targetPart}`,
    };
    turns.push(turn);
    lastTurn = turn;
    const typed = typedText === undefined ? {} : { text: typedText };
    let note: string | undefined;
    try {
      note = await taken.target.run(argument);
    } catch (error) {
      if (isAgentError(error) && RUNTIME_CODES.has(error.code)) throw error;
      const code = isAgentError(error) ? error.code : error instanceof Error ? error.name : 'unknown';
      history.push({ action: taken.target.description, ...typed, error: code });
      return;
    }
    history.push({ action: taken.target.description, ...typed, ...(note === undefined ? {} : { note }) });
  }
  /** One turn call label, e.g. type [3] textbox "New todo" = "Buy milk". */
  function callLabel(space: ActionSpace, taken: Taken, operation: string, text?: string): string {
    if (taken.elementKey === '') return taken.target.description;
    const element = space.elements.find((item) => item.index === targetKeyIndex(taken.elementKey));
    if (element === undefined) return taken.target.description;
    const value = text === undefined ? '' : ` = ${JSON.stringify(text)}`;
    return `${operation} [${element.index}] ${element.role} ${JSON.stringify(element.label)}${value}`;
  }
  /** Field the text helper writes, falling back to the key when the element is gone. */
  function elementField(space: ActionSpace, key: string): FieldInput['field'] {
    const element = space.elements.find((item) => item.index === targetKeyIndex(key));
    if (element === undefined) return { label: key, role: 'textbox' };
    return { label: element.label, role: element.role, ...(element.value === undefined ? {} : { value: element.value }) };
  }
  /**
   * Verifies a done/failed claim on a fresh screen with the actions taken so
   * far, but no model reasoning. Returns a verdict, or undefined to continue
   * the loop. A verdict under the gates confirms nothing.
   */
  async function terminalCheck(claim: 'done' | 'failed'): Promise<StepVerdict | undefined> {
    const observation = await look();
    const space = spaceOf(observation, true);
    if (space === undefined) return rejectClaim(claim, 'incomplete observation');
    const screenshot = screenshotOf(observation);
    const request = completionRequest({
      goal: ctx.step.instruction,
      params: nonSecretParams(ctx.step.params),
      path: observation.path ?? '',
      pageText: space.pageText,
      elements: elementRecords(space),
      history,
      statuses: space.statuses,
      ...(screenshot === undefined ? {} : { screenshot }),
    });
    const answers = await ask(request);
    if (answers === undefined) return blocked(budgetMessage());
    const verdict = need(answers.verdict, 'verdict');
    const settled = gated(verdict) ? verdict.choice : 'below gate';
    if (claim === 'done' && settled === 'holds') {
      return { status: 'passed', summary: `The screen shows the step is done (${describe(verdict)}).` };
    }
    if (claim === 'failed' && settled === 'fails') {
      const summary = `The screen shows the step failed (${describe(verdict)}).`;
      return { status: 'failed', errorCode: 'ACTION_FAILED', summary };
    }
    return rejectClaim(claim, settled);
  }
  /**
   * Records a rejected terminal claim and continues the loop. The second
   * rejected claim in a step ends it, decided by the check: visible
   * counter-evidence is a product failure, anything else an automation limit.
   */
  function rejectClaim(claim: 'done' | 'failed', check: string): StepVerdict | undefined {
    rejectedTerminals += 1;
    history.push({ action: claim, error: `check: ${check}` });
    if (rejectedTerminals < 2) return undefined;
    if (check === 'fails') {
      return { status: 'failed', errorCode: 'ACTION_FAILED', summary: `The screen contradicts the ${claim} claim.` };
    }
    return blocked(`The screen does not confirm the ${claim} claim (check: ${check}).`);
  }
}
/** Actions the text model sees when naming the next drawn control. */
const POINT_HISTORY = 60;
/**
 * CSS pixels of the regions the closer looks zoom into, and how much each
 * is enlarged: wide enough to hold a first look one column off. A tighter
 * third look was measured to drift on the runner's 768px capture.
 */
const ZOOM_BOXES = [400] as const;
const ZOOM_FACTOR = 2;
/** Columns and rows of the grid drawn on the zoomed region. */
const ZOOM_CELLS = 8;
/** The point a column and row score name on an image: the center of the scored position, inside the image. */
function pointOf(width: number, height: number, cellWidth: number, cellHeight: number, column: number, row: number): { x: number; y: number } {
  const clamp = (value: number, max: number): number => Math.min(max - 1, Math.max(0, Math.round(value)));
  return { x: clamp((column + 0.5) * cellWidth, width), y: clamp((row + 0.5) * cellHeight, height) };
}
/** Whether a decision model declares `score` among its question types. */
function supportsScores(model: DecisionExecutorOptions['model']): boolean {
  const supported = (model as { supportedQuestionTypes?: unknown }).supportedQuestionTypes;
  return Array.isArray(supported) && supported.includes('score');
}
/** A model answer the request never offered: our validation, never the provider's text. */
function invalid(message: string): AgentError {
  return new AgentError('MODEL_OUTPUT_INVALID', message);
}
/** Requires an answer the model returned; its absence is our bug or a broken transport. */
function need(answer: Decision | undefined, what: string): Decision {
  if (answer === undefined) throw invalid(`The decision model returned no ${what} answer.`);
  return answer;
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
