import type { LanguageModel } from 'ai';
import type { ExecutorObservation, StepExecutor, StepExecutorContext, StepTurn, StepVerdict } from 'e2e';
import { AgentError, isAgentError } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import { decide, requireDecide, type Decision } from './decide.ts';
import { actionSpace, type ActionSpace, type Control, type Operation, type Target } from './elements.ts';
import {
  assertionRequest,
  completionRequest,
  decisionRequest,
  elementRecords,
  nonSecretParams,
  targetKeyIndex,
  type DecisionRequest,
  type HistoryEntry,
} from './questions.ts';
import { fieldText, type FieldInput } from './text.ts';
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
  const textModel = options.textModel;
  return {
    name: 'decision',
    version: '1',
    cache: 'inherit',
    ...(textModel === undefined ? {} : { model: textModel }),
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
  let previousFingerprint: string | undefined;
  let startPath: string | undefined;
  let lastTurn: StepTurn | undefined;
  let rejectedTerminals = 0;
  const finish = (verdict: StepVerdict): StepVerdict => {
    ctx.attachTurns(turns);
    ctx.attachTranscript(transcript.join('\n'));
    return verdict;
  };
  const gated = (decision: Decision): boolean =>
    decision.probability >= minProbability && decision.confidence >= minConfidence;
  const describe = (decision: Decision): string =>
    `p=${decision.probability.toFixed(3)}, confidence ${decision.confidence.toFixed(3)}`;
  const budgetMessage = (): string =>
    `The step did not conclude within its ${ctx.budgets.maxModelCalls} decision calls.`;
  /**
   * The action space of a complete observation; undefined when the tree is
   * missing or empty. Verdict views pass `typing: true` so a field the step
   * filled keeps its row and value even when the step itself cannot type.
   */
  const spaceOf = (observation: ExecutorObservation, typing: boolean): ActionSpace | undefined => {
    const tree = observation.tree;
    if (observation.treeUnavailable || tree === undefined || emptyTree(observation)) return undefined;
    return actionSpace(ctx, { path: observation.path ?? '', viewport: observation.viewport, tree }, typing);
  };
  const ask = async (request: DecisionRequest): Promise<Record<string, Decision> | undefined> => {
    if (calls >= ctx.budgets.maxModelCalls) return undefined;
    transcript.push(JSON.stringify({ state: request.state, questions: request.questions }));
    calls += 1;
    const answers = await decide(ctx, model, request, options.providerOptions);
    transcript.push(JSON.stringify(answers));
    return answers;
  };
  const askText = async (field: FieldInput['field'], page: string): Promise<string | null | undefined> => {
    if (calls >= ctx.budgets.maxModelCalls) return undefined;
    if (language === undefined) throw invalid('The decision model chose type with no text model configured.');
    calls += 1;
    return fieldText(ctx, language, {
      goal: ctx.step.instruction,
      context: ctx.agentContext ?? null,
      params: nonSecretParams(ctx.step.params),
      field,
      page,
      recentActions: history.slice(-6),
    });
  };
  if (ctx.step.kind === 'assert') {
    const observation = await ctx.observe({ tree: true });
    const space = spaceOf(observation, true);
    if (space === undefined) return finish(inconclusive('A complete semantic observation is required.'));
    const request = assertionRequest(ctx.step.instruction, observation.path ?? '', space.pageText, elementRecords(space));
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
    const observation = await ctx.observe({ tree: true });
    if (startPath === undefined) startPath = observation.path ?? '';
    const space = spaceOf(observation, canType);
    if (space === undefined) return finish(blocked('A complete semantic observation is required.'));
    const changed = space.fingerprint !== previousFingerprint;
    if (lastTurn !== undefined) {
      lastTurn.outcome += changed ? ', page changed' : ', page unchanged';
      lastTurn = undefined;
    }
    const previous = history.at(-1);
    if (previous !== undefined) history[history.length - 1] = { ...previous, pageChanged: changed };
    previousFingerprint = space.fingerprint;
    if (stalled(history)) return finish(blocked('Three actions in a row changed nothing on screen.'));
    const answers = await ask(decisionRequest(ctx, space, history, observation.path ?? ''));
    if (answers === undefined) return finish(blocked(budgetMessage()));
    const op = need(answers.operation, 'operation');
    if (!gated(op)) return finish(blocked(`The next operation is uncertain (${describe(op)}).`));
    if (op.choice === 'blocked') return finish(blocked('The decision model cannot make progress.'));
    if (op.choice === 'done' || op.choice === 'failed') {
      const terminal = await terminalCheck(op.choice);
      if (terminal !== undefined) return finish(terminal);
      continue;
    }
    const { taken, targetAnswer } = resolveTarget(op.choice, answers, space);
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
    let secret: string | undefined;
    if (op.choice === 'typeSecret') {
      const resolved = resolveSecret(answers.secret);
      if (resolved.answer !== undefined && !gated(resolved.answer)) {
        return finish(blocked(`The next secret is uncertain (${describe(resolved.answer)}).`));
      }
      secret = resolved.name;
    }
    await runTarget(taken, op, targetAnswer, space, secret);
  }
  /** Resolves the chosen operation to a bound target. Throws MODEL_OUTPUT_INVALID for anything not offered. */
  function resolveTarget(
    choice: string,
    answers: Record<string, Decision>,
    space: ActionSpace,
  ): { taken: Taken; targetAnswer?: Decision } {
    const control = space.controls.get(choice as Control);
    if (control !== undefined) return { taken: { target: control, operation: choice, elementKey: '' } };
    const group = space.targets.get(choice as Operation);
    if (group === undefined) throw invalid('The decision model chose an unavailable operation.');
    if (group.size === 1) {
      const only = group.entries().next();
      if (only.done === true) throw invalid('The decision model chose an unavailable target.');
      return { taken: { target: only.value[1], operation: choice, elementKey: only.value[0] } };
    }
    const answer = answers[`${choice}_target`];
    if (answer === undefined) throw invalid('The decision model returned no target answer.');
    const target = group.get(answer.choice);
    if (target === undefined) throw invalid('The decision model chose an unavailable target.');
    return { taken: { target, operation: choice, elementKey: answer.choice }, targetAnswer: answer };
  }
  /** Resolves the secret fill: the declared secret, or the gated secret answer with 2+ secrets. */
  function resolveSecret(answer: Decision | undefined): { name: string; answer?: Decision } {
    const secrets = ctx.step.secrets;
    if (secrets.length === 1 && secrets[0] !== undefined) return { name: secrets[0].name };
    if (answer === undefined) throw invalid('The decision model returned no secret answer.');
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
    argument?: string,
    typedText?: string,
  ): Promise<void> {
    const targetPart = targetAnswer === undefined ? '' : `, target p=${targetAnswer.probability.toFixed(3)}`;
    const turn: StepTurn = {
      index: turns.length + 1,
      calls: [callLabel(space, taken, op.choice, argument)],
      outcome: `op p=${op.probability.toFixed(3)}${targetPart}`,
    };
    turns.push(turn);
    lastTurn = turn;
    const typed = typedText === undefined ? {} : { text: typedText };
    try {
      await taken.target.run(argument);
    } catch (error) {
      if (isAgentError(error) && RUNTIME_CODES.has(error.code)) throw error;
      const code = isAgentError(error) ? error.code : error instanceof Error ? error.name : 'unknown';
      history.push({ action: taken.target.description, ...typed, error: code });
      return;
    }
    history.push({ action: taken.target.description, ...typed });
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
    const observation = await ctx.observe({ tree: true });
    const space = spaceOf(observation, true);
    if (space === undefined) return rejectClaim(claim, 'incomplete observation');
    const path = observation.path ?? '';
    const request = completionRequest({
      goal: ctx.step.instruction,
      params: nonSecretParams(ctx.step.params),
      origin: startPath ?? path,
      path,
      pageText: space.pageText,
      elements: elementRecords(space),
      history,
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
