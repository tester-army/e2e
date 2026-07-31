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
import type { CacheLocator, PathAction } from '../cache/index.ts';
import type { OperationContext, SemanticNode } from '../driver/index.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import type { Momentum, ScrollDirection, Secret } from '../types.ts';
import { AgentError } from './error.ts';
import type { AgentContext, Invocation } from './invocation.ts';
import { toAgentError } from './invocation.ts';
import type { AgentObservation } from './observation.ts';
import type { ProtocolValidation } from './protocol.ts';
import { authorizeSecretFill } from './secrets.ts';

/* -------------------------------------------------------------------------- */
/* Argument specs                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One argument of one action: how it is declared to the provider, how it reads
 * in the prompt, and how a response value becomes a typed argument.
 *
 * An optional argument is an `ArgSpec<T | undefined>` whose `parse` accepts
 * absence, so the parsed type follows from the spec rather than from a second
 * flag the type system would have to reconcile.
 */
export interface ArgSpec<T> {
  readonly schema: JSONSchema7;
  /** How this argument is described in the request text. */
  readonly hint: string;
  readonly required: boolean;
  parse(value: unknown, observation: AgentObservation): ProtocolValidation<T>;
}

const REF_MAX_LENGTH = 256;
const EXPLANATION_MAX_LENGTH = 8192;

function ok<T>(value: T): ProtocolValidation<T> {
  return { ok: true, value };
}

function fail(issue: string): { ok: false; issue: string } {
  return { ok: false, issue };
}

/** Makes any spec optional, accepting absence as `undefined`. */
function optional<T>(spec: ArgSpec<T>): ArgSpec<T | undefined> {
  return {
    ...spec,
    required: false,
    hint: `${spec.hint} (optional)`,
    parse: (value, observation) =>
      value === undefined ? ok(undefined) : spec.parse(value, observation),
  };
}

/**
 * A node of the current observation.
 *
 * Validating the reference here rather than at dispatch is what stops a model
 * from naming something it was never shown: an invented id or a stale revision
 * is invalid output worth one repair round, and the alternative — acting on
 * whatever node happens to carry that id now — acts on the wrong thing.
 */
const node = (purpose: string): ArgSpec<SemanticNode> => ({
  required: true,
  hint: `"target": { "id": <the node id exactly as printed after "#">, "revision": <observation revision> } — ${purpose}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
      revision: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
    },
  },
  parse: (value, observation) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail('target must be an { id, revision } node reference');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'id' && key !== 'revision') return fail(`target has no "${key}" field`);
    }
    const id = boundedString(record['id'], 1, REF_MAX_LENGTH);
    const revision = boundedString(record['revision'], 1, REF_MAX_LENGTH);
    if (id === null || revision === null) return fail('target id/revision are invalid');
    if (revision !== observation.revision) {
      return fail(
        `target revision "${revision}" is stale; the current observation is ` +
          `"${observation.revision}". Quote the revision printed with the observation you are reading.`,
      );
    }
    const found = observation.nodes.get(id);
    if (found === undefined) {
      return fail(`no node #${id} exists in observation "${observation.revision}"`);
    }
    return ok(found);
  },
});

const text = (name: string, purpose: string, maxLength: number): ArgSpec<string> => ({
  required: true,
  hint: `"${name}": <${purpose}>`,
  schema: { type: 'string', maxLength },
  parse: (value) => {
    const parsed = boundedString(value, 0, maxLength);
    return parsed === null ? fail(`${name} must be a string of at most ${maxLength} characters`) : ok(parsed);
  },
});

const shortText = (name: string, purpose: string, maxLength: number): ArgSpec<string> => ({
  required: true,
  hint: `"${name}": <${purpose}>`,
  schema: { type: 'string', minLength: 1, maxLength },
  parse: (value) => {
    const parsed = boundedString(value, 1, maxLength);
    return parsed === null ? fail(`${name} must be a non-empty string of at most ${maxLength} characters`) : ok(parsed);
  },
});

const oneOf = <T extends string>(name: string, values: readonly T[]): ArgSpec<T> => ({
  required: true,
  hint: `"${name}": ${values.map((value) => `"${value}"`).join(' | ')}`,
  schema: { type: 'string', enum: [...values] },
  parse: (value) =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
      ? ok(value as T)
      : fail(`${name} must be one of: ${values.join(', ')}`),
});

const integer = (name: string, min: number, max: number): ArgSpec<number> => ({
  required: true,
  hint: `"${name}": <integer ${min}-${max}>`,
  schema: { type: 'integer', minimum: min, maximum: max },
  parse: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? ok(value)
      : fail(`${name} must be an integer from ${min} through ${max}`),
});

const anyJson = (name: string, purpose: string): ArgSpec<unknown> => ({
  required: false,
  hint: `"${name}": <${purpose}>`,
  schema: {},
  parse: (value) => ok(value),
});

function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < min || value.length > max) return null;
  return value;
}

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

/**
 * One dispatchable action.
 *
 * `authorize` and `perform` are separate because the seam between them is the
 * security boundary: a denial has to be decidable before anything reaches the
 * driver, and folding them together is what makes an `execute()`-style tool
 * unable to refuse (14-security.md).
 */
export interface AgentAction<S extends ArgSpecs> {
  /** Wire `kind`, which two actions may share when a tiebreak distinguishes them. */
  readonly kind: string;
  /** One line for the request text: when to choose this action. */
  readonly when: string;
  readonly args: S;
  /** Runner-owned policy check. Throws before anything is dispatched. */
  authorize?(context: ActionContext, args: Args<S>): Promise<unknown>;
  /** Trail text, rendered from the observation rather than from model prose. */
  describe(args: Args<S>, name: (node: SemanticNode) => string): string;
  /**
   * The `cache-1` derivative to record after this action succeeds, or undefined
   * when it is not recordable. `locate` turns a node into a semantic locator;
   * returning undefined for a node it cannot address keeps the path honest
   * rather than storing something that would replay elsewhere.
   */
  record?(args: Args<S>, locate: (node: SemanticNode) => CacheLocator | undefined): PathAction | undefined;
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
  authorize?(context: ActionContext, args: never): Promise<unknown>;
  describe(args: never, name: (node: SemanticNode) => string): string;
  record?(args: never, locate: (node: SemanticNode) => CacheLocator | undefined): PathAction | undefined;
  perform(context: ActionContext, args: never, authorized: unknown): Promise<void>;
}

/** Declares one action, inferring its argument types from its specs. */
function action<const S extends ArgSpecs>(definition: AgentAction<S>): AnyAgentAction {
  return definition as unknown as AnyAgentAction;
}

const VALUE_MAX = 65_536;
const KEY_MAX = 128;
const URL_MAX = 8192;
const SENSITIVE_NAME_MAX = 128;

export const ACTION_SPACE: Readonly<Record<string, AnyAgentAction>> = {
  tap: action({
    kind: 'tap',
    when: 'press a button, link, checkbox, tab, or menu item once',
    args: { target: node('the control to press') },
    describe: (args, name) => `tapped ${name(args.target)}`,
    record: (args, locate) => {
      const target = locate(args.target);
      return target === undefined ? undefined : { kind: 'tap', target };
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
      value: text('value', 'the text to enter', VALUE_MAX),
    },
    describe: (args, name) => `typed ${JSON.stringify(args.value)} into ${name(args.target)}`,
    // The target only. Storing the literal would persist whatever a test typed —
    // names, addresses, contact details — into a cache directory projects are
    // encouraged to commit, and guidance never needs it: the value comes from
    // `<parameters>` on every run.
    record: (args, locate) => {
      const target = locate(args.target);
      return target === undefined ? undefined : { kind: 'type', target };
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
      sensitiveName: shortText('sensitiveName', 'the secret name from <parameters>', SENSITIVE_NAME_MAX),
      purpose: oneOf('purpose', ['password', 'one-time-code', 'generic-secret'] as const),
    },
    describe: (args, name) =>
      `filled ${name(args.target)} with the secret <secret:${args.sensitiveName}>`,
    // Name and purpose only. The value is resolved host-side per run and must
    // never reach the cache, not even through a digest.
    record: (args, locate) => {
      const target = locate(args.target);
      return target === undefined
        ? undefined
        : { kind: 'type', target, sensitiveName: args.sensitiveName, purpose: args.purpose };
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

  scroll: action({
    kind: 'scroll',
    when: 'the thing you need is not in the observation and the screen can move to reveal it',
    args: {
      direction: oneOf('direction', ['up', 'down', 'left', 'right'] as const),
      momentum: optional(oneOf('momentum', ['none', 'slow', 'fast'] as const)),
      target: optional(node('a container to scroll inside instead of the viewport')),
    },
    describe: (args, name) =>
      args.target === undefined
        ? `scrolled ${args.direction}`
        : `scrolled ${args.direction} within ${name(args.target)}`,
    record: (args, locate) => {
      const target = args.target === undefined ? undefined : locate(args.target);
      if (args.target !== undefined && target === undefined) return undefined;
      return {
        kind: 'scroll',
        direction: args.direction as ScrollDirection,
        ...(args.momentum === undefined ? {} : { momentum: args.momentum as Momentum }),
        ...(target === undefined ? {} : { target }),
      };
    },
    perform: (context, args) =>
      context.invocation.commit('scroll', () =>
        context.invocation.session.actions.scroll(
          args.direction as ScrollDirection,
          {
            ...(args.target === undefined ? {} : { target: args.target.ref }),
            ...(args.momentum === undefined ? {} : { momentum: args.momentum as Momentum }),
          },
          context.operation(),
        ),
      ),
  }),

  press: action({
    kind: 'press',
    when: 'submit with Enter, dismiss with Escape, or move focus with Tab',
    args: { key: shortText('key', 'a single key name, e.g. "Enter" or "Escape"', KEY_MAX) },
    describe: (args) => `pressed ${args.key}`,
    record: (args) => ({ kind: 'press', key: args.key }),
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
      durationMs: optional(integer('durationMs', 100, 10_000)),
    },
    describe: (args, name) => `long-pressed ${name(args.target)}`,
    record: (args, locate) => {
      const target = locate(args.target);
      if (target === undefined) return undefined;
      return {
        kind: 'longPress',
        target,
        ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
      };
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

  navigate: action({
    kind: 'navigate',
    when:
      'the instruction names a destination that cannot be reached from the current screen. ' +
      'Only origins the runner allows are permitted; anything else is refused',
    args: { url: shortText('url', 'an absolute or app-relative URL', URL_MAX) },
    describe: (args) => `navigated to ${args.url}`,
    // The requested URL, not the resolved one: the app base can differ between
    // runs, and origin policy re-authorizes on replay regardless.
    record: (args) => ({ kind: 'navigate', url: args.url }),
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
    args: {} as ArgSpecs,
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

/**
 * The request schema narrowed to a subset of kinds.
 *
 * Used when a budget is spent: an invocation with no action steps left is offered
 * only `observe` and `conclude`, so the model reports what happened instead of
 * being cut off mid-thought by a thrown budget error. 10-determinism.md describes
 * an invocation as starting with "an allowlist of method-specific tools and
 * remaining budgets", and this is that allowlist narrowing as the budget drains.
 */
export function toolSchemaFor(kinds: readonly string[]): JSONSchema7 {
  return buildToolSchema(new Set(kinds));
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
export function describeActionSpace(kinds?: readonly string[]): readonly string[] {
  const allowed = kinds === undefined ? undefined : new Set(kinds);
  return ENTRIES.filter((entry) => allowed === undefined || allowed.has(entry.kind)).map((entry) => {
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
export function actRequest(kinds?: readonly string[]): string {
  return [
  'Carry out the instruction one action at a time.',
  '',
  'Reply with exactly one JSON object: the single next action, chosen from the list below.',
  'Every object includes "toolVersion": "agent-tool-1" and "kind".',
  '',
  'Send only the fields listed for the kind you choose, and leave every other field out.',
  'The schema declares the fields of all kinds together, so it will accept fields that',
  'do not belong to yours; they are ignored, and omitting them is cheaper and clearer.',
  '',
  'Available actions:',
  ...describeActionSpace(kinds),
  '',
  'How to work:',
  '- The <observation> is the screen right now. Node ids are minted per observation, so',
  '  always quote the "revision" printed with the observation you are reading, and never',
  '  reuse an id from an earlier one.',
  '- <steps-already-taken> is what you have already done in this task. Do not repeat a step',
  '  that already succeeded; read the observation to see its effect and continue from there.',
  '- If a step there is marked failed, do not retry it unchanged. Try a different route, or',
  '  conclude with "failure" explaining what blocked you.',
  '- Take the shortest reliable path. Do nothing the instruction did not ask for: do not',
  '  submit a form that was only meant to be filled, and do not explore other pages.',
  '- Verify before concluding. A tap is not a result; the next observation is.',
  '- Conclude the moment the instruction is satisfied. Zero deviation: the caller has its own',
  '  steps for whatever comes after this one, and doing them here spends this budget on work',
  '  nobody asked for and leaves the caller unable to check the part it did ask for.',
  '  A multi-step form is finished when the step the instruction named is submitted. Do not',
  '  continue into the next one, and never proceed to payment, purchase, or confirmation',
  '  unless the instruction says so in those words.',
  '- Never send both an action and a conclusion. One object, one kind.',
  '- Do not give up at the first obstacle. A disabled button, a control that does nothing, or a',
  '  field that will not accept input is usually a symptom: look for the empty required field,',
  '  the unticked consent, the dialog in the way, or the thing that needs scrolling into view,',
  '  and fix that instead. Conclude "failure" only once you can name a blocker that survives',
  '  trying.',
  '- Running out of steps is not success. If you cannot finish, conclude with "failure".',
  ].join('\n');
}
