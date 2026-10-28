/**
 * The session's `run_code`: test statements run against the live app
 * before they go into a test. The code is parsed into the closed grammar of
 * `code-parse.ts` and never evaluated; the runner walks the parsed chains
 * and reaches each fixture member by a name the grammar's table listed, on
 * the session's `app` and a `screen` over the session's engine, so a line
 * run here waits, matches, and fails as the same line in a test would. Statements
 * run in order and stop at the first failure, each with its wait capped at
 * the call's `timeout`, and the result ends with what changed on screen.
 * The statements that pass, reads aside, join the session's `test_lines`.
 *
 * The coding agent is not trusted the way test code is. A Secret reaches the
 * screen only through the authorization `type_secret` runs, on the node the
 * fill lands on. Every node the screen reads passes the attempt's secret
 * ledger first, so a read returns, and a matcher compares, `<secret:name>`
 * where a value was: no pass or fail depends on a secret's characters. A
 * locator found by part of a text is matched inside the engine, where the
 * ledger cannot reach, so a project that configures secrets has those
 * refused before any statement runs.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { z } from 'zod';
import type { StepExecutorContext } from '../agent/executor.ts';
import { redactNode, type NodeRedaction } from '../agent/observation.ts';
import { recordPolicyEvent } from '../agent/phases.ts';
import type { ScreenPresenter } from '../agent/screen-update.ts';
import { authorizeSecretFill } from '../agent/secrets.ts';
import type { TargetSession } from '../engine/surface.ts';
import { createAsyncExpectation } from '../expect/async.ts';
import { classifyError, codedMessage, ConfigurationError, TestError, type E2EError } from '../internal/errors.ts';
import { isPlainObject, rejectUnknownOptions } from '../internal/options.ts';
import { describeExpression } from '../locator/expression.ts';
import { createScreen, locatorInternals, type LocatorInternals } from '../locator/screen.ts';
import { createScreenContext } from '../run/fixtures.ts';
import type { StandaloneAttempt } from '../run/standalone.ts';
import { secretHandle } from '../secrets.ts';
import type { App, Screen, Secret } from '../types.ts';
import { parseCode, type Call, type Chain, type Statement, type Value } from './code-parse.ts';
import { SURFACE } from './code-surface.ts';

/** How long one statement may wait unless the call says otherwise, in milliseconds. */
const RUN_CODE_TIMEOUT_MS = 5_000;
/** The longest a call may let one statement wait. */
const MAX_TIMEOUT_MS = 120_000;
/** Every member that builds a locator, so a query the grammar gains is checked as soon as it is listed. */
const QUERIES: ReadonlySet<string> = new Set([...SURFACE.locator].flatMap(([name, member]) => (member.kind === 'query' ? [name] : [])));
/** What the secret ledger writes where a value was. */
const SECRET_MARKER = '<secret:';

/** What the session hands `run_code`. */
export interface RunCodeSession {
  /** The session's attempt: its fixtures, agent runtime, budget, and engine session. */
  readonly attempt: StandaloneAttempt;
  /** The fixtures the target's engine contributes, which `run_code` names in a refusal and never runs. */
  readonly engineFixtures: readonly string[];
}

interface RunCodeOptions extends RunCodeSession {
  /** The session step, observed once the statements ran. */
  readonly context: StepExecutorContext;
  /** The session's presenter, so the screen comes back as changes since the one the agent holds. */
  readonly screen: ScreenPresenter;
  /** Told the source of every statement that passed and is not a read, in the order they ran, for `test_lines`. */
  readonly record?: ((passed: readonly string[]) => void) | undefined;
}

interface RunCodeArgs {
  readonly code: string;
  readonly timeout?: number | undefined;
}

/** The rendered result, and whether a statement failed. */
interface RunCodeResult {
  readonly text: string;
  readonly failed: boolean;
}

/** What became of one statement. */
type Outcome = { readonly statement: Statement; readonly value: unknown } | { readonly statement: Statement; readonly error: E2EError };

/** The `run_code` catalog tool. */
export function runCodeTool(options: RunCodeOptions): ToolSet[string] {
  const runner = new LineRunner(options.attempt);
  return {
    description: [
      'Run e2e test code against the live session before writing it into a test.',
      "Pass statements as they appear in a test body, such as await screen.getByLabel('Email').fill('ada@example.com'); await expect(screen.getByRole('status')).toHaveText('Saved').",
      "They run in order on the session's screen and app with the test API's own waiting, exactly-one rule, and matchers, and stop at the first failure.",
      `The result gives each statement's pass or failure (code and message) and a read's value, then what changed on screen. Each statement waits at most timeout ms (default ${String(RUN_CODE_TIMEOUT_MS)}).`,
      "Statements that pass, except reads, join test_lines' draft in the order they ran.",
      'The code is parsed, never evaluated as JavaScript: a statement starts with screen, app, or expect(locator), chains getBy* queries, filter, or, first, last, and nth, and ends in an action, a read, or a matcher.',
      "Arguments are literals, regular expressions, arrays, objects, locators on screen, and credentials.user('name').username.",
      "credentials.user('name').password and secrets.get('name') are accepted only as fill's value, and fill only where type_secret would.",
      'Reads and matchers see <secret:name> where a secret value is. When the project configures secrets, find locators by their exact text: a regular expression, exact: false, or hasText in a query is refused with POLICY_DENIED.',
    ].join(' '),
    inputSchema: z.object({
      code: z.string().min(1).describe('One or more test statements, separated by ";" or new lines'),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`How long each statement may wait, in milliseconds; default ${String(RUN_CODE_TIMEOUT_MS)}`),
    }).strict(),
    execute: (args: RunCodeArgs, call: ToolExecutionOptions<unknown>) => runCode(options, runner, args, call.abortSignal),
    toModelOutput: ({ output }: { readonly output: RunCodeResult }) => ({ type: output.failed ? ('error-text' as const) : ('text' as const), value: output.text }),
  };
}

/** Parses the code, runs its statements until one fails, and renders what happened. */
async function runCode(options: RunCodeOptions, runner: LineRunner, args: RunCodeArgs, signal: AbortSignal | undefined): Promise<RunCodeResult> {
  const statements = parseCode(args.code, { fixtures: options.engineFixtures });
  const { agentRuntime: runtime, budget } = options.attempt;
  refuseMarkerExpectations(statements);
  if (runtime.config.allSecrets.size > 0) refuseLocatorsByPart(statements);
  const timeout = args.timeout ?? RUN_CODE_TIMEOUT_MS;
  const outcomes: Outcome[] = [];
  for (const statement of statements) {
    if (signal?.aborted === true) break;
    try {
      outcomes.push({ statement, value: await budget.capped(timeout, () => runner.run(statement)) });
    } catch (cause) {
      outcomes.push({ statement, error: classifyError(cause) });
      break;
    }
  }
  options.record?.(outcomes.flatMap((outcome) => ('error' in outcome || isRead(outcome.statement) ? [] : [outcome.statement.source])));
  let screen: string;
  try {
    screen = options.screen.update(await options.context.observe(), { expectChange: false });
  } catch (cause) {
    screen = `Observing the screen afterwards failed: ${codedMessage(cause)}`;
  }
  const failed = outcomes.some((outcome) => 'error' in outcome);
  return { text: render(statements, outcomes, timeout, screen), failed };
}

/** Whether a statement only reads, which a test body has no use for once its value is known. */
function isRead(statement: Statement): boolean {
  return statement.body.kind === 'call' && statement.body.read;
}

/**
 * Refuses, before anything runs, a statement that finds a locator by part of
 * a text: a regular expression, an `exact` that is not `true`, or a `hasText`
 * filter. The engine matches those on unredacted text, secret values
 * included, so whether one matches could spell a value out a piece at a time.
 */
function refuseLocatorsByPart(statements: readonly Statement[]): void {
  statements.forEach((statement, index) => {
    const { body } = statement;
    const subject = body.kind === 'call' ? body.chain : body.locator;
    const calls = body.kind === 'call' ? subject.calls : [...subject.calls, body.matcher];
    if (![subject, ...locatorsIn(calls)].some((chain) => chain.calls.some(findsByPart))) return;
    throw new ConfigurationError(
      'POLICY_DENIED',
      `run_code: statement ${String(index + 1)} (${statement.source}) finds a locator by part of a text, and this project configures secrets: the engine matches a regular expression, exact: false, or hasText on unredacted text, so whether it matches could spell a secret out one piece at a time. Find the locator by its exact text; nothing ran.`,
    );
  });
}

/**
 * Refuses, before anything runs, a matcher that expects a secret marker. The
 * matcher would compare it against redacted text and pass, while the same
 * line in a test compares the real value and fails.
 */
function refuseMarkerExpectations(statements: readonly Statement[]): void {
  const holdsMarker = (value: Value): boolean => {
    switch (value.kind) {
      case 'literal':
        return typeof value.value === 'string' && value.value.includes(SECRET_MARKER);
      case 'regex':
        return value.source.includes(SECRET_MARKER);
      case 'array':
        return value.items.some(holdsMarker);
      case 'object':
        return value.entries.some(([, item]) => holdsMarker(item));
      default:
        return false;
    }
  };
  statements.forEach((statement, index) => {
    if (statement.body.kind !== 'expect' || !statement.body.matcher.args.some(holdsMarker)) return;
    throw new ConfigurationError(
      'INVALID_ARGUMENT',
      `run_code: statement ${String(index + 1)} (${statement.source}) expects ${SECRET_MARKER}name>, which only redacted text holds: a test compares the real value, so the line would fail there. Assert what the screen shows around the secret instead; nothing ran.`,
    );
  });
}

/** Every locator passed as an argument to these calls, at any depth. */
function locatorsIn(calls: readonly Call[]): Chain[] {
  const found: Chain[] = [];
  const visit = (value: Value): void => {
    if (value.kind === 'locator') {
      found.push(value.chain);
      for (const call of value.chain.calls) call.args.forEach(visit);
    } else if (value.kind === 'array') {
      value.items.forEach(visit);
    } else if (value.kind === 'object') {
      for (const [, item] of value.entries) visit(item);
    }
  };
  for (const call of calls) call.args.forEach(visit);
  return found;
}

/** Whether a query or filter matches part of a text. */
function findsByPart(call: Call): boolean {
  if (call.name === 'filter') return call.args.some((arg) => arg.kind === 'object' && arg.entries.some(([key]) => key === 'hasText'));
  if (!QUERIES.has(call.name)) return false;
  const partial = (value: Value, key: string | undefined): boolean => {
    if (value.kind === 'regex') return true;
    if (key === 'exact') return !(value.kind === 'literal' && value.value === true);
    return value.kind === 'object' && value.entries.some(([entry, item]) => partial(item, entry));
  };
  return call.args.some((arg) => partial(arg, undefined));
}

/**
 * A screen over the attempt's engine session whose every read passes the
 * secret ledger, wired like the attempt's own through the same factory.
 */
function redactingScreen(attempt: StandaloneAttempt): Screen {
  const runtime = attempt.agentRuntime;
  const redaction: NodeRedaction = { redact: runtime.redact, redactCut: runtime.redactCut };
  return createScreen(
    createScreenContext({
      session: readingRedacted(attempt.session, redaction),
      budget: attempt.budget,
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      config: runtime.config,
      steps: runtime.steps,
      secrets: runtime.secrets,
      redaction,
      appOrigin: runtime.app.base?.origin,
    }),
  );
}

/**
 * The session with `read` answering each node through the ledger; every other
 * member is the session's own, which `createEngineSession` builds as plain
 * properties of one object.
 */
function readingRedacted(session: TargetSession, redaction: NodeRedaction): TargetSession {
  return { ...session, read: async (ref, operation) => redactNode(await session.read(ref, operation), redaction) };
}

/** Runs parsed statements on the session's fixtures. */
class LineRunner {
  private readonly screen: Screen;
  private readonly app: App;

  constructor(private readonly attempt: StandaloneAttempt) {
    this.screen = redactingScreen(attempt);
    this.app = attempt.fixtures.app;
  }

  async run(statement: Statement): Promise<unknown> {
    const { body } = statement;
    if (body.kind === 'call') {
      const value: unknown = await this.chain(body.chain);
      return body.read ? value : undefined;
    }
    const expectation = createAsyncExpectation(this.locator(this.chain(body.locator), 'expect'));
    await this.invoke(body.negated ? expectation.not : expectation, body.matcher);
    return undefined;
  }

  /** Walks a chain from its fixture: a query returns its locator at once, the last call its promise. */
  private chain(chain: Chain): unknown {
    let receiver: unknown = chain.root === 'screen' ? this.screen : this.app;
    for (const call of chain.calls) {
      const [first, second] = call.args;
      receiver =
        call.name === 'fill' && first?.kind === 'secret'
          ? this.fillSecret(this.locator(receiver, 'fill'), this.secret(first), this.fillTimeout(second))
          : this.invoke(receiver, call);
    }
    return receiver;
  }

  /** What a walked chain built, as the locator `expect` and a secret fill take: its expression and its screen. */
  private locator(value: unknown, api: string): LocatorInternals {
    const internals = locatorInternals(value);
    if (internals === undefined) throw new TestError('INVALID_ARGUMENT', `${api} takes a locator`);
    return internals;
  }

  /** Calls a member the grammar's table listed by this name, on the object it was listed for. */
  private invoke(receiver: unknown, call: Call): unknown {
    const method: unknown = Reflect.get(receiver as object, call.name);
    if (typeof method !== 'function') {
      throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `${call.name} is not available on this target`);
    }
    return Reflect.apply(method, receiver, call.args.map((arg) => this.value(arg)));
  }

  /** An argument as the fixture receives it; a Secret stays a handle and goes through `fillSecret` only. */
  private value(value: Value): unknown {
    switch (value.kind) {
      case 'literal':
        return value.value;
      case 'regex':
        return new RegExp(value.source, value.flags);
      case 'array':
        return value.items.map((item) => this.value(item));
      case 'object': {
        // Defined, not assigned: a property named like a prototype member stays a plain own property.
        const object = {};
        for (const [key, item] of value.entries) {
          Object.defineProperty(object, key, { value: this.value(item), enumerable: true, writable: true, configurable: true });
        }
        return object;
      }
      case 'locator':
        return this.chain(value.chain);
      case 'username':
        return this.credential(value.credential).username;
      case 'secret':
        throw new TestError('INVALID_ARGUMENT', "a secret is accepted only as fill's value");
    }
  }

  private credential(name: string) {
    const credential = this.attempt.agentRuntime.config.credentials.get(name);
    if (credential === undefined) {
      throw new ConfigurationError('AUTH_CREDENTIAL_UNAVAILABLE', `credential "${name}" is not configured; add it to config.credentials or E2E_USER_* variables`);
    }
    return credential;
  }

  /** The handle a secret reference names, from the session's own config. */
  private secret(value: Extract<Value, { kind: 'secret' }>): Secret {
    if (value.from === 'credential') return secretHandle(this.credential(value.name).password);
    const secret = this.attempt.agentRuntime.config.secrets.get(value.name);
    if (secret === undefined) {
      throw new ConfigurationError('SECRET_UNAVAILABLE', `secret "${value.name}" is not configured; add it to config.secrets`);
    }
    return secretHandle(secret);
  }

  /**
   * `locator.fill(secret)` under the authorization `type_secret` runs: a
   * configured secret, an enabled editable field, and a password field for a
   * password, checked on the node the value lands on, every time the locator
   * resolves. A test's own `fill` skips this as trusted code; `run_code`
   * statements come from the coding agent, which is not.
   */
  private fillSecret(internals: LocatorInternals, secret: Secret, timeout: number | undefined): Promise<void> {
    const runtime = this.attempt.agentRuntime;
    const host = {
      recordPolicy: (policy: string, decision: 'allowed' | 'denied', code?: string) => recordPolicyEvent(runtime.steps, policy, decision, code),
    };
    const { engine, steps } = internals.context;
    return steps.run('locator', 'locator.fill', describeExpression(internals.expression), () =>
      engine.fillSecret(internals.expression, (node) => authorizeSecretFill(host, runtime, secret, node), timeout),
    );
  }

  /** The timeout in `fill`'s options, checked as `locator.fill` checks them. */
  private fillTimeout(value: Value | undefined): number | undefined {
    const options = value === undefined ? undefined : this.value(value);
    if (options !== undefined && !isPlainObject(options)) throw new TestError('INVALID_ARGUMENT', 'fill options must be a plain object');
    rejectUnknownOptions('fill', options, ['timeout']);
    const timeout = options?.['timeout'];
    if (timeout !== undefined && typeof timeout !== 'number') throw new TestError('INVALID_ARGUMENT', 'fill timeout must be a number of milliseconds');
    return timeout;
  }
}

/** The result: a summary, each statement with its outcome, then the screen. */
function render(statements: readonly Statement[], outcomes: readonly Outcome[], timeout: number, screen: string): string {
  const failure = outcomes.findIndex((outcome) => 'error' in outcome);
  const total = statements.length;
  const lines: string[] = [];
  if (failure !== -1) {
    const unrun = total - failure - 1;
    lines.push(
      `Statement ${String(failure + 1)} of ${String(total)} failed${failure === 0 ? '' : `; the ${failure === 1 ? 'one' : String(failure)} before it passed`}${unrun === 0 ? '' : `, and ${unrun === 1 ? 'the one' : `the ${String(unrun)}`} after it did not run`}.` +
        ` Each statement waited at most ${String(timeout)} ms.${failure === 0 ? '' : ' The app is where the passing statements left it: run the fixed statement and the rest from here.'}`,
    );
  } else if (outcomes.length < total) {
    lines.push(`Cancelled after ${String(outcomes.length)} of ${String(total)} statements.`);
  } else {
    lines.push(total === 1 ? 'The statement passed.' : `All ${String(total)} statements passed.`);
  }
  statements.forEach((statement, index) => {
    const outcome = outcomes[index];
    const number = `${String(index + 1)}.`;
    if (outcome === undefined) {
      lines.push(`${number} not run: ${statement.source}`);
    } else if ('error' in outcome) {
      lines.push(`${number} failed: ${statement.source}`, indent(`${outcome.error.code}: ${outcome.error.message}`));
    } else {
      lines.push(`${number} passed: ${statement.source}`);
      const { value } = outcome;
      if (value !== undefined) lines.push(indent(typeof value === 'string' && value.includes('\n') ? `returned:\n${value}` : `returned ${JSON.stringify(value)}`));
    }
  });
  return `${lines.join('\n')}\n\n${screen}`;
}

function indent(text: string): string {
  return text.split('\n').map((line) => `   ${line}`).join('\n');
}
