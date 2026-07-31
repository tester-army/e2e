/**
 * The `agent-tool-1` action space (spec/schema/agent-tool-v1.schema.json).
 *
 * One table is the single source of truth for the planning tier's vocabulary.
 * Everything the runner needs is derived from it: the structured-output request
 * schema, the prompt's action list, the response validator, the authorization
 * gate, the trail rendering, and the dispatch. Adding an action means adding one
 * entry here and nothing anywhere else — a manifest maintained next to a schema
 * drifts from it, and an action the prompt advertises but the validator rejects
 * costs a repair round every time the model believes it.
 *
 * The spec's `oneOf` remains authoritative over wire and cache output. This file
 * describes the same union as a flat discriminated object, because strict
 * structured-output modes reject a root union.
 */

import type { JSONSchema7 } from 'ai';
import {
  PATH_LIMITS,
  SCROLL_DIRECTIONS,
  SCROLL_MOMENTUMS,
  SECRET_PURPOSES,
  type CacheLocator,
  type PathAction,
} from '../cache/index.ts';
import type { OperationContext, SemanticNode } from '../driver/index.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import { describeExpression } from '../locator/expression.ts';
import type { Secret } from '../types.ts';
import {
  anyJson,
  EXPLANATION_MAX_LENGTH,
  fail,
  integer,
  node,
  ok,
  oneOf,
  optional,
  shortText,
  text,
  type ArgSpec,
} from './arg-spec.ts';
import { AgentError } from './error.ts';
import type { AgentContext, Invocation } from './invocation.ts';
import { toAgentError } from './invocation.ts';
import type { AgentObservation } from './observation.ts';
import { planningRequest } from './prompts.ts';
import type { ProtocolValidation } from './protocol.ts';
import { authorizeSecretFill } from './secrets.ts';


/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/** What an action is dispatched against. */
export interface ActionContext {
  readonly invocation: Invocation;
  readonly runtime: AgentContext;
  /** Secrets this call may fill, keyed by name. Only those passed in `params`. */
  readonly secrets: ReadonlyMap<string, Secret>;
  operation(): OperationContext;
}

/**
 * Argument specs with their value types erased.
 *
 * `unknown` and not `never`: a spec's type parameter appears only in `parse`'s
 * return, so it is covariant, and an `ArgSpec<SemanticNode>` is an
 * `ArgSpec<unknown>`.
 */
type ArgSpecs = Readonly<Record<string, ArgSpec<unknown>>>;

/** The parsed arguments of one action, derived from its specs. */
type Args<S> = { readonly [K in keyof S]: S[K] extends ArgSpec<infer T> ? T : never };

/** Turns a node into the locator a cache entry can store it as. */
type Locate = (node: SemanticNode) => CacheLocator | undefined;

/**
 * How one action appears in a recorded path, when it is recordable at all.
 *
 * The three parts are one member because they are one concept read three ways
 * and are only correct together: `record` writes the shape, `owns` recognizes
 * that shape coming back off disk, and `describe` renders it as the hint the
 * model is shown. Splitting them into three optional members is what let the
 * guidance renderer drift into a separate hand-written switch that silently
 * mislabelled any kind it had not been taught.
 */
export interface PathRecording<S extends ArgSpecs, A extends PathAction> {
  /**
   * The `cache-1` derivative to record after this action succeeds, or undefined
   * when this occurrence is not recordable. `locate` turns a node into a
   * semantic locator; returning undefined for a node it cannot address keeps the
   * path honest rather than storing something that would replay elsewhere.
   */
  record(args: Args<S>, locate: Locate): A | undefined;
  /**
   * Whether a recorded action came from this entry. Defaults to a `kind` match,
   * so only entries sharing a wire kind — the plain and sensitive fills — need
   * to say more.
   */
  owns?(action: PathAction): boolean;
  /**
   * The suggestion prose for one recorded action of this entry.
   *
   * Takes the shape this entry's own `record` produces, not the whole union, so
   * a renderer reads its fields directly instead of re-narrowing a union it
   * already knows the answer for.
   */
  describe(action: A): string;
}

/**
 * One dispatchable action.
 *
 * `authorize` and `perform` are separate because the seam between them is the
 * security boundary: a denial has to be decidable before anything reaches the
 * driver, and folding them together is what makes an `execute()`-style tool
 * unable to refuse (14-security.md).
 */
export interface AgentAction<S extends ArgSpecs, A extends PathAction = PathAction> {
  /** Wire `kind`, which two actions may share when a tiebreak distinguishes them. */
  readonly kind: string;
  /** One line for the request text: when to choose this action. */
  readonly when: string;
  readonly args: S;
  /**
   * Whether performing this action can change the application's state.
   *
   * The loop uses it to decide what stays on the menu: an action that only reads
   * or repositions is always safe, while the set of actions offered narrows once
   * something has been committed and can no longer be taken back.
   */
  readonly mutating: boolean;
  /** Runner-owned policy check. Throws before anything is dispatched. */
  authorize?(context: ActionContext, args: Args<S>): Promise<unknown>;
  /** Trail text, rendered from the observation rather than from model prose. */
  describe(args: Args<S>, name: (node: SemanticNode) => string): string;
  readonly path?: PathRecording<S, A>;
  /** Performs the action. Called only after `authorize` resolved. */
  perform(context: ActionContext, args: Args<S>, authorized: unknown): Promise<void>;
}

/**
 * One action with its argument types erased, as the registry stores them.
 *
 * The callbacks take `never` rather than the erased `Args` record so a precisely
 * typed implementation stays assignable: a function accepting
 * `{ target: SemanticNode }` is assignable to one accepting `never`, which is
 * exactly the widening the registry needs and the reverse of what `unknown`
 * would allow.
 */
export interface AnyAgentAction {
  readonly kind: string;
  readonly when: string;
  readonly args: ArgSpecs;
  readonly mutating: boolean;
  authorize?(context: ActionContext, args: never): Promise<unknown>;
  describe(args: never, name: (node: SemanticNode) => string): string;
  readonly path?: {
    record(args: never, locate: Locate): PathAction | undefined;
    owns?(action: PathAction): boolean;
    describe(action: PathAction): string;
  };
  perform(context: ActionContext, args: never, authorized: unknown): Promise<void>;
}

/** Declares one action, inferring its argument and recorded types from it. */
function action<const S extends ArgSpecs, A extends PathAction>(
  definition: AgentAction<S, A>,
): AnyAgentAction {
  return definition as unknown as AnyAgentAction;
}

/**
 * The keys a planning call may ask for.
 *
 * An allowlist and not a bounded string, because in the planning tier the key
 * comes from the model. Everywhere else in the API it comes from test code —
 * 02-test-api.md is explicit that a `press` key is trusted input that never
 * appears in a prompt — so this is the one place a key is untrusted, and the
 * driver hands whatever it is straight to the keyboard.
 *
 * What that excludes is the point. `Alt+ArrowLeft`, `BrowserBack`, `F5`, and
 * `Control+r` are all keys a real driver honours, and every one of them navigates
 * or reloads: they would walk straight around the navigation withdrawal and
 * discard the flow, which is the exact failure that withdrawal exists to prevent.
 * So no modifier that reaches browser chrome is offered, and the set is limited to
 * keys that act within the page.
 *
 * Declaring it as an enum also means a key outside the set is impossible to send
 * rather than merely refused, so it costs no repair round.
 */
const PRESSABLE_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Shift+Tab',
  'Space',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
] as const;

/**
 * Records a targeted action, or nothing when its node cannot be addressed.
 *
 * Every recordable action but `press` and `navigate` shares this shape, and
 * spelling it out per entry is how the "returns undefined for an unaddressable
 * node" rule would eventually be forgotten in one of them.
 */
function targeted<T extends PathAction>(
  target: CacheLocator | undefined,
  build: (target: CacheLocator) => T,
): T | undefined {
  return target === undefined ? undefined : build(target);
}

export const ACTION_SPACE: Readonly<Record<string, AnyAgentAction>> = {
  tap: action({
    kind: 'tap',
    when: 'press a button, link, checkbox, tab, or menu item once',
    args: { target: node('the control to press') },
    mutating: true,
    describe: (args, name) => `tapped ${name(args.target)}`,
    path: {
      record: (args, locate) => targeted(locate(args.target), (target) => ({ kind: 'tap', target })),
      describe: (recorded) => `tap ${describeExpression(recorded.target)}`,
    },
    perform: (context, args) =>
      context.invocation.commit('tap', () =>
        context.invocation.session.actions.tap({ ref: args.target.ref }, context.operation()),
      ),
  }),

  type: action({
    kind: 'type',
    when: 'enter text you were given, or that the instruction states literally',
    args: {
      target: node('the field to fill'),
      value: text('value', 'the text to enter', PATH_LIMITS.value),
    },
    mutating: true,
    describe: (args, name) => `typed ${JSON.stringify(args.value)} into ${name(args.target)}`,
    path: {
      // The target only. Storing the literal would persist whatever a test typed
      // — names, addresses, contact details — into a cache directory projects
      // are encouraged to commit, and guidance never needs it: the value comes
      // from `<parameters>` on every run.
      record: (args, locate) =>
        targeted(locate(args.target), (target) => ({ kind: 'type', target })),
      owns: (recorded) => recorded.kind === 'type' && !('sensitiveName' in recorded),
      describe: (recorded) =>
        `type the value it needs into ${describeExpression(recorded.target)}`,
    },
    perform: (context, args) =>
      context.invocation.commit('type', () =>
        context.invocation.session.actions.type(
          { ref: args.target.ref },
          args.value,
          false,
          context.operation(),
        ),
      ),
  }),

  secretType: action({
    kind: 'type',
    when:
      'fill a field with a secret named in <parameters>. You never see its value, ' +
      'and must never guess one or type it as plain text',
    args: {
      target: node('the field to fill'),
      sensitiveName: shortText(
        'sensitiveName',
        'the secret name from <parameters>',
        PATH_LIMITS.sensitiveName,
      ),
      purpose: oneOf('purpose', SECRET_PURPOSES),
    },
    mutating: true,
    describe: (args, name) =>
      `filled ${name(args.target)} with the secret <secret:${args.sensitiveName}>`,
    path: {
      // Name and purpose only. The value is resolved host-side per run and must
      // never reach the cache, not even through a digest.
      record: (args, locate) =>
        targeted(locate(args.target), (target) => ({
          kind: 'type',
          target,
          sensitiveName: args.sensitiveName,
          purpose: args.purpose,
        })),
      owns: (recorded) => recorded.kind === 'type' && 'sensitiveName' in recorded,
      describe: (recorded) =>
        `fill ${describeExpression(recorded.target)} with the secret "${recorded.sensitiveName}"`,
    },
    // Resolving the plaintext is the authorization: it happens only after every
    // check passes, and the value exists for exactly one handoff to the driver.
    authorize: async (context, args) => {
      const secret = context.secrets.get(args.sensitiveName);
      if (secret === undefined) {
        context.invocation.recordPolicy('act.secret', 'denied', 'POLICY_DENIED');
        throw new AgentError(
          'POLICY_DENIED',
          `agent.act requested a fill for "${args.sensitiveName}", which is not among its parameters`,
        );
      }
      if (secret.purpose !== args.purpose) {
        context.invocation.recordPolicy('act.secret', 'denied', 'POLICY_DENIED');
        throw new AgentError(
          'POLICY_DENIED',
          `secret "${secret.name}" has purpose ${secret.purpose}, not ${args.purpose}`,
        );
      }
      return authorizeSecretFill(context.invocation, context.runtime, secret, args.target);
    },
    perform: (context, args, authorized) =>
      context.invocation.commit('type', () =>
        context.invocation.session.actions.type(
          { ref: args.target.ref },
          authorized as string,
          true,
          context.operation(),
        ),
      ),
  }),

  // The one non-mutating driver action: it moves the viewport, so an agent that
  // has already committed something can still look around without being able to
  // undo it.
  scroll: action({
    kind: 'scroll',
    when: 'the thing you need is not in the observation and the screen can move to reveal it',
    args: {
      direction: oneOf('direction', SCROLL_DIRECTIONS),
      momentum: optional(oneOf('momentum', SCROLL_MOMENTUMS)),
      target: optional(node('a container to scroll inside instead of the viewport')),
    },
    mutating: false,
    describe: (args, name) =>
      args.target === undefined
        ? `scrolled ${args.direction}`
        : `scrolled ${args.direction} within ${name(args.target)}`,
    path: {
      record: (args, locate) => {
        const target = args.target === undefined ? undefined : locate(args.target);
        if (args.target !== undefined && target === undefined) return undefined;
        return {
          kind: 'scroll' as const,
          direction: args.direction,
          ...(args.momentum === undefined ? {} : { momentum: args.momentum }),
          ...(target === undefined ? {} : { target }),
        };
      },
      describe: (recorded) =>
        recorded.target === undefined
          ? `scroll ${recorded.direction}`
          : `scroll ${recorded.direction} within ${describeExpression(recorded.target)}`,
    },
    perform: (context, args) =>
      context.invocation.commit('scroll', () =>
        context.invocation.session.actions.scroll(
          args.direction,
          {
            ...(args.target === undefined ? {} : { target: args.target.ref }),
            ...(args.momentum === undefined ? {} : { momentum: args.momentum }),
          },
          context.operation(),
        ),
      ),
  }),

  press: action({
    kind: 'press',
    when: 'submit with Enter, dismiss with Escape, or move focus with Tab',
    args: { key: oneOf('key', PRESSABLE_KEYS) },
    mutating: true,
    describe: (args) => `pressed ${args.key}`,
    path: {
      record: (args) => ({ kind: 'press' as const, key: args.key }),
      describe: (recorded) => `press ${recorded.key}`,
    },
    perform: (context, args) =>
      context.invocation.commit('press', () =>
        context.invocation.session.actions.press(args.key, context.operation()),
      ),
  }),

  longPress: action({
    kind: 'longPress',
    when: 'the control needs a sustained press rather than a tap',
    args: {
      target: node('the control to hold'),
      durationMs: optional(
        integer('durationMs', PATH_LIMITS.longPressMs.min, PATH_LIMITS.longPressMs.max),
      ),
    },
    mutating: true,
    describe: (args, name) => `long-pressed ${name(args.target)}`,
    path: {
      record: (args, locate) =>
        targeted(locate(args.target), (target) => ({
          kind: 'longPress' as const,
          target,
          ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
        })),
      describe: (recorded) => `long-press ${describeExpression(recorded.target)}`,
    },
    perform: (context, args) =>
      context.invocation.commit('longPress', () =>
        context.invocation.session.actions.longPress(
          { ref: args.target.ref },
          args.durationMs,
          context.operation(),
        ),
      ),
  }),

  // Withdrawn from the menu once anything has been committed. See
  // `offeredKinds` in act.ts: this is the only action that can discard the whole
  // flow, and a stuck agent reaches for it to start over.
  navigate: action({
    kind: 'navigate',
    when:
      'the instruction names a destination that cannot be reached from the current screen. ' +
      'Only origins the runner allows are permitted; anything else is refused',
    args: { url: shortText('url', 'an absolute or app-relative URL', PATH_LIMITS.url) },
    mutating: true,
    describe: (args) => `navigated to ${args.url}`,
    path: {
      // The requested URL, not the resolved one: the app base can differ between
      // runs, and origin policy re-authorizes on replay regardless.
      record: (args) => ({ kind: 'navigate' as const, url: args.url }),
      describe: (recorded) => `navigate to ${recorded.url}`,
    },
    // The model proposes a destination; the allowed-origin policy decides. The
    // URL resolves against the app base, so an app-relative instruction does not
    // require the model to know the deployment's host.
    authorize: async (context, args) => {
      if (context.invocation.session.web === undefined) {
        throw new AgentError(
          'POLICY_DENIED',
          'agent.act proposed a navigation, but this driver exposes no navigation capability',
        );
      }
      try {
        const resolved = resolveNavigationUrl(
          args.url,
          context.invocation.appBase,
          context.runtime.config.app.allowedOrigins,
        );
        context.invocation.recordPolicy('act.navigate', 'allowed');
        return resolved.url;
      } catch (cause) {
        context.invocation.recordPolicy('act.navigate', 'denied', 'POLICY_DENIED');
        throw toAgentError(cause);
      }
    },
    perform: (context, _args, authorized) => {
      const web = context.invocation.session.web;
      if (web === undefined) throw new AgentError('POLICY_DENIED', 'navigation is unavailable');
      // The runner owns settling elsewhere, so the driver's default wait applies.
      return context.invocation.commit('navigate', () =>
        web.goto(authorized as string, undefined, context.operation()),
      );
    },
  }),
};

/* -------------------------------------------------------------------------- */
/* Control kinds                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The two responses that are not driver actions.
 *
 * They are declared here so the request schema and the prompt still derive from
 * one place, but they carry no `perform`: the loop owns them, because neither
 * touches the application. Modelling them as actions would imply the runner
 * could dispatch a conclusion.
 */
export const CONTROL_KINDS = {
  observe: {
    kind: 'observe',
    when:
      'the screen is mid-transition and the observation does not yet show the result of ' +
      'what you just did',
    args: {} satisfies ArgSpecs,
  },
  conclude: {
    kind: 'conclude',
    when:
      'the instruction is fully carried out ("success"), or it cannot be ("failure"). ' +
      'This is the only way to finish',
    args: {
      status: oneOf('status', ['success', 'failure'] as const),
      // Optional to the validator even though the schema requires it: a model
      // that omits prose must not lose an otherwise valid conclusion.
      explanation: optional(
        text('explanation', 'one or two sentences, grounded in the observation', EXPLANATION_MAX_LENGTH),
      ),
      data: anyJson('data', 'the value the instruction asks for, when it asks for one'),
    } satisfies ArgSpecs,
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Derived: recorded paths                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Renders one recorded action as the suggestion the model is shown.
 *
 * Delegates to the entry that produced it, so the vocabulary has one owner in
 * this direction too. Returns undefined for an action no entry claims, which
 * only happens when an entry was removed while a cache file still names it: no
 * hint is strictly better than a hint rendered by whichever renderer happened to
 * fall through.
 */
export function describeRecordedAction(recorded: PathAction): string | undefined {
  for (const entry of Object.values(ACTION_SPACE)) {
    const path = entry.path;
    if (path === undefined) continue;
    const owns = path.owns?.(recorded) ?? entry.kind === recorded.kind;
    if (owns) return path.describe(recorded as never);
  }
  return undefined;
}

/** Every entry the schema, prompt, and validator are built from. */
interface Entry {
  readonly name: string;
  readonly kind: string;
  readonly when: string;
  readonly args: ArgSpecs;
}

const ENTRIES: readonly Entry[] = [
  ...Object.entries(ACTION_SPACE).map(([name, entry]) => ({
    name,
    kind: entry.kind,
    when: entry.when,
    args: entry.args,
  })),
  ...Object.values(CONTROL_KINDS).map((entry) => ({ name: entry.kind, ...entry })),
];

/**
 * Actions keyed by name, in a Map rather than an object.
 *
 * Nothing here is ever keyed by a model-supplied string, but a registry that is
 * looked up during response handling is exactly where a `__proto__` key becomes
 * a dispatch, so the lookup has no prototype to inherit from in the first place.
 */
const BY_NAME = new Map(Object.entries(ACTION_SPACE));

/* -------------------------------------------------------------------------- */
/* Derived: the offered allowlist                                             */
/* -------------------------------------------------------------------------- */

/** Every wire kind the table declares, in declaration order. */
const ALL_KINDS: readonly string[] = [...new Set(ENTRIES.map((entry) => entry.kind))];

/** What an invocation with no action steps left may still answer with. */
export const WIND_DOWN_KINDS: readonly string[] = ['observe', 'conclude'];

/**
 * The action kinds still on the menu, given what the invocation has already done.
 *
 * Two narrowings, both expressed the same way rather than as branches at the
 * dispatch site:
 *
 * - With no action steps left, only `observe` and `conclude` remain, so the model
 *   reports what happened instead of being cut off by a thrown budget error.
 * - Once any action has committed, every *mutating* action stays but `navigate`
 *   goes. Navigating is how a stuck agent starts over, and starting over is the
 *   one recovery that is strictly destructive here: it discards work the caller's
 *   later steps depend on and cannot be undone. Before anything has committed it
 *   is harmless — it is just getting to the right screen — so the offer is tied
 *   to that fact rather than to a flag.
 *
 * 10-determinism.md describes an invocation as starting with "an allowlist of
 * method-specific tools and remaining budgets"; this is that allowlist as the
 * invocation progresses.
 */
export function offeredKinds(state: {
  readonly actionStepsRemaining: number;
  readonly committed: boolean;
}): readonly string[] {
  if (state.actionStepsRemaining === 0) return WIND_DOWN_KINDS;
  if (!state.committed) return ALL_KINDS;
  return ALL_KINDS.filter((kind) => kind !== 'navigate');
}

/* -------------------------------------------------------------------------- */
/* Derived: request schema                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The structured-output schema one planning call is made under, unioned from
 * every entry's arguments.
 *
 * Only the discriminator is required: an argument required here would be
 * demanded of every kind, including the ones that must not carry it.
 * `additionalProperties` stays false so a provider strips anything undeclared,
 * which is why every argument any action can take has to appear.
 */
export const TOOL_SCHEMA: JSONSchema7 = buildToolSchema();

/** Built schemas by offered kind set, so a loop does not rebuild one per round. */
const SCHEMA_CACHE = new Map<string, JSONSchema7>();

/**
 * The request schema for one offered allowlist, as `offeredKinds` computed it.
 *
 * There are only ever a handful of distinct allowlists in a run, so they are
 * memoized: a planning loop asks for one every round, and rebuilding the union
 * each time would be work with no result that can differ.
 */
export function toolSchemaFor(kinds: readonly string[]): JSONSchema7 {
  const key = [...kinds].toSorted().join(',');
  const cached = SCHEMA_CACHE.get(key);
  if (cached !== undefined) return cached;
  const built = buildToolSchema(new Set(kinds));
  SCHEMA_CACHE.set(key, built);
  return built;
}

function buildToolSchema(allowed?: ReadonlySet<string>): JSONSchema7 {
  const entries = allowed === undefined ? ENTRIES : ENTRIES.filter((e) => allowed.has(e.kind));
  const properties: Record<string, JSONSchema7> = {
    // Single-value enum rather than const: strict structured-output modes across
    // providers accept enum but not const.
    toolVersion: { type: 'string', enum: ['agent-tool-1'] },
    kind: { type: 'string', enum: [...new Set(entries.map((entry) => entry.kind))] },
  };
  for (const entry of entries) {
    for (const [name, spec] of Object.entries(entry.args)) {
      // Two actions sharing an argument name must describe it identically, or
      // the union would silently keep whichever was declared last.
      const existing = properties[name];
      const declared = spec.schema;
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(declared)) {
        throw new Error(
          `action space conflict: "${name}" is declared with two different schemas`,
        );
      }
      properties[name] = declared;
    }
  }
  // `explanation` is required of every kind, not just `conclude`.
  //
  // A flat schema cannot say "required when kind is conclude", so anything this
  // schema leaves optional is something a model will sometimes omit — and a
  // validator that then demands it stalls the flow, because the repair round
  // re-sends the same request and gets the same answer. Requiring it globally is
  // the only way to actually ask for it. Non-concluding kinds do not need it, so
  // theirs is spent on a one-line rationale that `--debug` prints next to the
  // action, which is worth more than the handful of tokens it costs.
  return {
    type: 'object',
    additionalProperties: false,
    required: ['toolVersion', 'kind', 'explanation'],
    properties,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived: request text                                                      */
/* -------------------------------------------------------------------------- */

/** The action list of the planning request, derived from the same table. */
export function describeActionSpace(kinds: readonly string[]): readonly string[] {
  const allowed = new Set(kinds);
  return ENTRIES.filter((entry) => allowed.has(entry.kind)).map((entry) => {
    const args = Object.values(entry.args).map((spec) => spec.hint);
    const shape = args.length === 0 ? 'no other fields' : args.join(', ');
    return `- kind "${entry.kind}" — ${entry.when}.\n  ${shape}`;
  });
}

/* -------------------------------------------------------------------------- */
/* Derived: validation                                                        */
/* -------------------------------------------------------------------------- */

/** One validated response: an action to dispatch, or a control kind. */
export type ToolCall =
  | { readonly control: 'observe' }
  | {
      readonly control: 'conclude';
      readonly status: 'success' | 'failure';
      readonly explanation: string;
      readonly data: unknown;
    }
  | {
      readonly control?: undefined;
      readonly name: string;
      readonly action: AnyAgentAction;
      readonly args: Readonly<Record<string, unknown>>;
      /** The model's one-line reason, when it gave one. Untrusted prose. */
      readonly rationale?: string | undefined;
    };

const DECLARED = new Set(['toolVersion', 'kind', ...Object.keys(TOOL_SCHEMA.properties ?? {})]);

/**
 * Validates one proposed response against the action space and the observation
 * it must quote.
 *
 * Both halves are one pass because both are reasons to re-ask rather than to
 * fail. A response carrying a field its own kind does not take is rejected
 * outright: the flat request schema cannot express "tap takes no url", so this
 * is the only thing standing between a confused response and a dispatch.
 */
export function validateToolCall(
  value: unknown,
  observation: AgentObservation,
  kinds?: readonly string[],
): ProtocolValidation<ToolCall> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('response is not an agent-tool-1 object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!DECLARED.has(key)) return fail(`unknown field "${key}"`);
  }
  if (record['toolVersion'] !== 'agent-tool-1') return fail('unknown toolVersion');
  const kind = record['kind'];
  if (typeof kind !== 'string') return fail('kind must be a string');

  const offered =
    kinds === undefined ? ENTRIES : ENTRIES.filter((entry) => kinds.includes(entry.kind));
  const candidates = offered.filter((entry) => entry.kind === kind);
  if (candidates.length === 0) {
    return fail(`kind must be one of: ${[...new Set(offered.map((e) => e.kind))].join(', ')}`);
  }
  const chosen = selectCandidate(candidates, record);
  if (!chosen.ok) return chosen;
  const entry = chosen.value;

  // Fields the chosen kind does not take are ignored, not rejected. The request
  // schema is one flat object, so every argument any kind can take is declared
  // on it, and plenty of models answer by filling in every declared property.
  // Rejecting that made a correct decision — the right kind, with a stray field
  // beside it — unrecoverable, and the repair round could only produce the same
  // response again. Selection is what stays strict: an ambiguous set of
  // arguments is still refused below.
  const args: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(entry.args)) {
    const raw = record[name];
    // Naming the field is not enough to converge on: the rejection carries the
    // exact object to send, because a model that omitted a field once will
    // usually omit it again when told only that it is missing.
    if (raw === undefined && spec.required) {
      return fail(`${kind} requires "${name}". Send exactly: ${template(entry)}`);
    }
    const parsed = spec.parse(raw, observation);
    if (!parsed.ok) return parsed;
    args[name] = parsed.value;
  }

  if (entry.kind === 'observe') return ok({ control: 'observe' });
  if (entry.kind === 'conclude') {
    return ok({
      control: 'conclude',
      status: args['status'] as 'success' | 'failure',
      explanation: (args['explanation'] as string | undefined) ?? '',
      data: args['data'],
    });
  }
  const dispatchable = BY_NAME.get(entry.name);
  if (dispatchable === undefined) return fail(`no action named ${entry.name}`);
  const rationale = typeof record['explanation'] === 'string' ? record['explanation'] : undefined;
  return ok({
    name: entry.name,
    action: dispatchable,
    args,
    ...(rationale === undefined || rationale === '' ? {} : { rationale }),
  });
}

/**
 * Picks the one entry a response names, when several share a wire kind.
 *
 * An entry is viable when every argument it requires is present. That is a
 * stronger test than asking each entry whether it recognizes the response,
 * because a stray field cannot make an entry viable — only its own required
 * arguments can — so `type` with a spurious `purpose` still resolves to the
 * plain fill it obviously is.
 *
 * Genuine ambiguity is still refused. A `type` carrying both a `value` and a
 * complete `sensitiveName`/`purpose` pair leaves it unclear whether the value
 * the runner fills came from the model or from the host, and that is precisely
 * the distinction the secret boundary rests on.
 */
function selectCandidate(
  candidates: readonly Entry[],
  record: Readonly<Record<string, unknown>>,
): ProtocolValidation<Entry> {
  if (candidates.length === 1) return ok(candidates[0]!);
  const viable = candidates.filter((candidate) =>
    Object.entries(candidate.args).every(
      ([name, spec]) => !spec.required || record[name] !== undefined,
    ),
  );
  if (viable.length === 1) return ok(viable[0]!);
  const shapes = candidates
    .map((candidate) => requiredNames(candidate).join(' + '))
    .join(', or ');
  return fail(
    viable.length === 0
      ? `${candidates[0]!.kind} needs one of these complete argument sets: ${shapes}`
      : `${candidates[0]!.kind} supplied several complete argument sets at once; send exactly one of: ${shapes}`,
  );
}

/** The minimal legal object for one entry, as a repair prompt can quote it. */
function template(entry: Entry): string {
  const fields = requiredNames(entry).map((name) => `"${name}": <${name}>`);
  return `{ "toolVersion": "agent-tool-1", "kind": "${entry.kind}", ${[...fields, '"explanation": <one short sentence>'].join(', ')} }`;
}

function requiredNames(entry: Entry): readonly string[] {
  return Object.entries(entry.args)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name);
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/** Authorizes one action, then performs it against the action-step budget. */
export async function dispatch(
  context: ActionContext,
  call: Extract<ToolCall, { control?: undefined }>,
): Promise<void> {
  const args = call.args as never;
  const authorized = await call.action.authorize?.(context, args);
  await call.action.perform(context, args, authorized);
}

/** Renders one call for the trail and for repetition detection. */
export function describeCall(call: ToolCall, observation: AgentObservation): string {
  if (call.control === 'observe') return 'looked at the screen again';
  if (call.control === 'conclude') return `concluded ${call.status}`;
  return call.action.describe(call.args as never, (found) => describeNode(found, observation));
}

function describeNode(target: SemanticNode, observation: AgentObservation): string {
  const found = observation.nodes.get(target.ref.id) ?? target;
  const name = (found.name ?? found.text ?? '').replace(/\s+/g, ' ').trim();
  const role = found.role ?? 'node';
  return name === '' ? `a ${role}` : `the ${role} ${JSON.stringify(name)}`;
}

/** Request text for one planning step of `agent.act`. */
export function actRequest(kinds: readonly string[]): string {
  return planningRequest(describeActionSpace(kinds));
}
