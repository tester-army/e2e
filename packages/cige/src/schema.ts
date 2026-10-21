/**
 * The CIGE test case: Context, Intent, Guardrails, and Execution, as the
 * standard defines them (https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard).
 * The wire shape is the one `schema/cige-1.schema.json` pins; this module
 * validates a parsed file against it and normalizes it into the case the
 * runner reads: every entry carries a stable id, every list is present, and
 * the lowercase field names the paper uses read the same as the capitalized
 * ones the CIGE skills write.
 */

import { z } from 'zod';

/** A stable id: what a run summary names a step, a guardrail, or an evidence item by. */
const Id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'an id is 1 through 64 letters, digits, dots, dashes, or underscores, starting with a letter or digit');

const Text = z.string().trim().min(1);

/** A value an Execution step hands `agent.act` as a param; the file it came from is JSON, and the runner checks it again. */
const ParamValue = z.unknown();

const ExecutionAct = z.strictObject({
  id: Id,
  step: Text,
  params: z.record(z.string(), ParamValue).optional(),
});

const ExecutionVerify = z.strictObject({
  id: Id,
  verify: Text,
  vision: z.boolean().optional(),
});

const ExecutionEntry = z.union([Text, ExecutionAct, ExecutionVerify]);

const EvidenceAssert = z.strictObject({
  id: Id.optional(),
  assert: Text,
  vision: z.boolean().optional(),
});

const EvidenceHook = z.strictObject({
  id: Id.optional(),
  hook: Id,
  description: Text.optional(),
});

const EvidenceEntry = z.union([Text, EvidenceAssert, EvidenceHook]);

const IntentObject = z.strictObject({
  statement: Text,
  success: z.array(Text).optional(),
  failure: z.array(Text).optional(),
  evidence: z.array(EvidenceEntry).optional(),
  judge: z.boolean().optional(),
});

const GuardrailDeny = z
  .strictObject({
    actions: z.array(Text).min(1).optional(),
    summary: z.array(Text).min(1).optional(),
  })
  .refine((deny) => deny.actions !== undefined || deny.summary !== undefined, {
    message: 'deny needs actions, summary, or both; an empty deny would enforce nothing',
  });

const GuardrailObject = z.strictObject({
  id: Id.optional(),
  rule: Text,
  deny: GuardrailDeny.optional(),
});

const GuardrailEntry = z.union([Text, GuardrailObject]);

const PreconditionHook = z.strictObject({
  hook: Id,
  description: Text.optional(),
});

// Strict: Context is what the agent reads, so a key the runner would drop is
// an error rather than a fact that silently never reaches the model.
const AgentPin = z.union([Id, z.array(Id).min(1)]);

const Context = z.strictObject({
  system: Text.optional(),
  environment: Text.optional(),
  actor: Text.optional(),
  agent: AgentPin.optional(),
  platforms: z.array(Text).min(1).optional(),
  requires: z.array(Text).min(1).optional(),
  session: Id.optional(),
  open: Text.optional(),
  tools: z.array(Text).optional(),
  preconditions: z.array(z.union([Text, PreconditionHook])).optional(),
  facts: z.array(Text).optional(),
  prompts: z.array(Text).optional(),
  specRef: Text.optional(),
  buildRef: Text.optional(),
  expectedRef: Text.optional(),
});

/** A value a variant fills a `{name}` placeholder with: JSON primitives only, so a variant never carries a secret. */
const VariantValue = z.union([z.string(), z.number(), z.boolean()]);

const Variant = z.strictObject({
  id: Id,
  params: z.record(z.string(), VariantValue).optional(),
  platforms: z.array(Text).min(1).optional(),
  agent: AgentPin.optional(),
  session: Id.optional(),
});

/** The file as written, with its field names already capitalized. */
const CigeFile = z.strictObject({
  $schema: z.string().optional(),
  cige: z.literal(1).optional(),
  id: Id.optional(),
  Context,
  Intent: z.union([Text, IntentObject]),
  Guardrails: z.array(GuardrailEntry).optional(),
  Execution: z.array(ExecutionEntry).min(1),
  Variants: z.array(Variant).min(1).optional(),
});

/** A CIGE test case as authored: what a `.cige.json` file holds. */
export type CigeTestCase = z.input<typeof CigeFile>;

/** One Execution entry after normalization: an `agent.act` goal or an `agent.assert` check. */
export type CigeExecutionStep =
  | { readonly kind: 'act'; readonly id: string; readonly text: string; readonly params?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'verify'; readonly id: string; readonly text: string; readonly vision?: boolean };

/** One piece of evidence a pass requires: a judgment of the screen, or a named hook in your code. */
export type CigeEvidence =
  | { readonly kind: 'assert'; readonly id: string; readonly text: string; readonly vision?: boolean }
  | { readonly kind: 'hook'; readonly id: string; readonly hook: string; readonly description?: string };

/** One guardrail: its prose, and the actions the runner refuses on sight. */
export interface CigeGuardrail {
  readonly id: string;
  readonly rule: string;
  readonly deny?: { readonly actions?: readonly string[]; readonly summary?: readonly string[] };
}

/** A precondition: a fact the agent reads, or a hook your code runs before the first step. */
export type CigePrecondition =
  | { readonly kind: 'fact'; readonly text: string }
  | { readonly kind: 'hook'; readonly hook: string; readonly description?: string };

export interface CigeContext {
  readonly system?: string;
  /** Prose for the model, and the key of `environments` in the CIGE config that replays the case. */
  readonly environment?: string;
  readonly actor?: string;
  readonly agent?: string | readonly string[];
  /** The platforms the case runs on; other targets skip it. */
  readonly platforms?: readonly string[];
  /** Capabilities a target must have to run the case. */
  readonly requires?: readonly string[];
  /** The session a setup test saved, restored before the case runs. */
  readonly session?: string;
  readonly open?: string;
  readonly tools: readonly string[];
  readonly preconditions: readonly CigePrecondition[];
  readonly facts: readonly string[];
  /** The `prompts` paths as written, relative to the file. */
  readonly prompts: readonly string[];
  /** The text of each `prompts` file, in order, once a loader has read them. */
  readonly fragments: readonly string[];
  readonly specRef?: string;
  readonly buildRef?: string;
  /** A pointer to what this build is expected to produce: mocks, fixtures, or golden data. Never sent to the model. */
  readonly expectedRef?: string;
}

/** One combination of a case's dimensions: values for its `{name}` placeholders, and where it runs. */
export interface CigeVariant {
  readonly id: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly platforms?: readonly string[];
  readonly agent?: string | readonly string[];
  readonly session?: string;
}

export interface CigeIntent {
  readonly statement: string;
  readonly success: readonly string[];
  readonly failure: readonly string[];
  readonly evidence: readonly CigeEvidence[];
  /** Whether the runner judges the statement itself on screen once the evidence holds. */
  readonly judge: boolean;
}

/** A validated, normalized CIGE test case. */
export interface CigeCase {
  readonly id: string;
  /** The file the case was read from, when it came from one. */
  readonly file?: string;
  readonly context: CigeContext;
  readonly intent: CigeIntent;
  readonly guardrails: readonly CigeGuardrail[];
  readonly execution: readonly CigeExecutionStep[];
  /** The combinations the case runs as; empty when it runs once. */
  readonly variants: readonly CigeVariant[];
  /** The variant this case was resolved for, once `expandVariants` has. */
  readonly variant?: string;
  /** That variant's values, so a hook checks the data this run used. */
  readonly params?: CigeVariant['params'];
}

/** A CIGE file that does not validate. The message names the file and every problem in it. */
export class CigeValidationError extends Error {
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[]) {
    super(`invalid CIGE test case ${source}:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'CigeValidationError';
    this.issues = issues;
  }
}

const FIELDS = ['Context', 'Intent', 'Guardrails', 'Execution', 'Variants'] as const;

/** Maps lowercase field names (the paper's spelling) onto the capitalized ones, refusing a file that spells one field both ways. */
function capitalize(value: unknown, issues: string[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const field of FIELDS) {
    const lower = field.toLowerCase();
    if (!(lower in out)) continue;
    if (field in out) {
      issues.push(`"${lower}" and "${field}" are the same field; keep one`);
      continue;
    }
    out[field] = out[lower];
    delete out[lower];
  }
  return out;
}

/** The id an Intent statement implies: its words, lowercased and joined by dashes; `''` when it has no Latin letters or digits. */
export function slugify(statement: string): string {
  const slug = statement
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug;
}

/**
 * The messages one zod issue stands for. A union reports only "Invalid
 * input" at the entry; the branch that came closest (fewest problems, then
 * the deepest one) says what is actually wrong with it.
 */
function messagesOf(issue: z.core.$ZodIssue, base: readonly PropertyKey[] = []): string[] {
  const at = [...base, ...issue.path];
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const depth = (branch: readonly z.core.$ZodIssue[]): number => Math.max(0, ...branch.map((entry) => entry.path.length));
    const closest = issue.errors.toSorted((a, b) => a.length - b.length || depth(b) - depth(a))[0];
    if (closest !== undefined && closest.length > 0) return closest.flatMap((entry) => messagesOf(entry, at));
  }
  return [`${pathOf(at)}: ${issue.message}`];
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join('').replace(/^\./, '');
}

/**
 * Validates one parsed CIGE file and normalizes it. `source` names it in
 * errors. Throws `CigeValidationError` listing every problem at once.
 */
export function parseCige(value: unknown, source = 'test case'): CigeCase {
  const issues: string[] = [];
  const parsed = CigeFile.safeParse(capitalize(value, issues));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push(...messagesOf(issue));
  }
  if (!parsed.success || issues.length > 0) throw new CigeValidationError(source, issues);
  const file = parsed.data;

  const intentObject = typeof file.Intent === 'string' ? { statement: file.Intent } : file.Intent;
  const execution: CigeExecutionStep[] = file.Execution.map((entry, index) => {
    if (typeof entry === 'string') return { kind: 'act', id: `e${index + 1}`, text: entry };
    if ('step' in entry) {
      return { kind: 'act', id: entry.id, text: entry.step, ...(entry.params === undefined ? {} : { params: entry.params }) };
    }
    return { kind: 'verify', id: entry.id, text: entry.verify, ...(entry.vision === undefined ? {} : { vision: entry.vision }) };
  });
  const evidence: CigeEvidence[] = (intentObject.evidence ?? []).map((entry, index) => {
    const id = typeof entry === 'string' ? `v${index + 1}` : (entry.id ?? `v${index + 1}`);
    if (typeof entry === 'string') return { kind: 'assert', id, text: entry };
    if ('assert' in entry) return { kind: 'assert', id, text: entry.assert, ...(entry.vision === undefined ? {} : { vision: entry.vision }) };
    return { kind: 'hook', id, hook: entry.hook, ...(entry.description === undefined ? {} : { description: entry.description }) };
  });
  const guardrails: CigeGuardrail[] = (file.Guardrails ?? []).map((entry, index) => {
    const id = typeof entry === 'string' ? `g${index + 1}` : (entry.id ?? `g${index + 1}`);
    if (typeof entry === 'string') return { id, rule: entry };
    const deny = entry.deny === undefined
      ? undefined
      : {
          ...(entry.deny.actions === undefined ? {} : { actions: entry.deny.actions }),
          ...(entry.deny.summary === undefined ? {} : { summary: entry.deny.summary }),
        };
    return { id, rule: entry.rule, ...(deny === undefined ? {} : { deny }) };
  });
  const context = file.Context;
  const preconditions: CigePrecondition[] = (context.preconditions ?? []).map((entry) =>
    typeof entry === 'string'
      ? { kind: 'fact', text: entry }
      : { kind: 'hook', hook: entry.hook, ...(entry.description === undefined ? {} : { description: entry.description }) },
  );

  const variants: CigeVariant[] = (file.Variants ?? []).map((entry) => ({
    id: entry.id,
    params: entry.params ?? {},
    ...(entry.platforms === undefined ? {} : { platforms: entry.platforms }),
    ...(entry.agent === undefined ? {} : { agent: entry.agent }),
    ...(entry.session === undefined ? {} : { session: entry.session }),
  }));

  const judge = intentObject.judge ?? true;
  duplicates('Execution', execution.map((step) => step.id), issues);
  duplicates('Guardrails', guardrails.map((rule) => rule.id), issues);
  duplicates('Intent.evidence', evidence.map((item) => item.id), issues);
  duplicates('Variants', variants.map((variant) => variant.id), issues);
  // A judgment takes no params, so a variant must fill every placeholder in one; an act
  // step's placeholder may also be filled by the step's own params.
  const judged = new Set(
    [
      intentObject.statement,
      ...(intentObject.success ?? []),
      ...(intentObject.failure ?? []),
      ...execution.flatMap((step) => (step.kind === 'verify' ? [step.text] : [])),
      ...evidence.flatMap((item) => (item.kind === 'assert' ? [item.text] : [])),
    ].flatMap(placeholdersIn),
  );
  const acted = execution.flatMap((step) =>
    step.kind === 'act' ? placeholdersIn(step.text).filter((name) => !Object.hasOwn(step.params ?? {}, name)) : [],
  );
  const placeholders = new Set([...judged, ...execution.flatMap((step) => placeholdersIn(step.text))]);
  for (const variant of variants) {
    for (const name of Object.keys(variant.params)) {
      if (!placeholders.has(name)) {
        issues.push(`Variants ${variant.id}: param "${name}" fills no {${name}} placeholder in Intent, Execution, or evidence`);
      }
    }
    for (const name of new Set([...judged, ...acted])) {
      if (!Object.hasOwn(variant.params, name)) {
        issues.push(`Variants ${variant.id}: no value for the {${name}} placeholder; the test would run on the literal text`);
      }
    }
  }
  for (const rule of guardrails) {
    for (const pattern of rule.deny?.summary ?? []) {
      if (!isPattern(pattern)) {
        issues.push(`Guardrails ${rule.id}: deny.summary ${JSON.stringify(pattern)} is not a valid regular expression`);
      }
    }
  }
  const id = file.id ?? slugify(intentObject.statement);
  if (id === '') issues.push('id: the Intent statement has no Latin letters or digits to derive an id from; set "id"');
  if (!judge && evidence.length === 0 && !execution.some((step) => step.kind === 'verify')) {
    issues.push('Intent: with "judge": false, a pass needs evidence or a verify step; this case would pass on its actions alone');
  }
  if (issues.length > 0) throw new CigeValidationError(source, issues);

  return {
    id,
    context: {
      ...(context.system === undefined ? {} : { system: context.system }),
      ...(context.environment === undefined ? {} : { environment: context.environment }),
      ...(context.actor === undefined ? {} : { actor: context.actor }),
      ...(context.agent === undefined ? {} : { agent: context.agent }),
      ...(context.platforms === undefined ? {} : { platforms: context.platforms }),
      ...(context.requires === undefined ? {} : { requires: context.requires }),
      ...(context.session === undefined ? {} : { session: context.session }),
      ...(context.open === undefined ? {} : { open: context.open }),
      tools: context.tools ?? [],
      preconditions,
      facts: context.facts ?? [],
      prompts: context.prompts ?? [],
      fragments: [],
      ...(context.specRef === undefined ? {} : { specRef: context.specRef }),
      ...(context.buildRef === undefined ? {} : { buildRef: context.buildRef }),
      ...(context.expectedRef === undefined ? {} : { expectedRef: context.expectedRef }),
    },
    intent: {
      statement: intentObject.statement,
      success: intentObject.success ?? [],
      failure: intentObject.failure ?? [],
      evidence,
      judge,
    },
    guardrails,
    execution,
    variants,
  };
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The `{name}` placeholders a piece of case text refers to. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** `text` with each `{name}` that `values` has filled in; any other placeholder stays as written. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string | number | boolean>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

function isPattern(source: string): boolean {
  try {
    return new RegExp(source, 'i') instanceof RegExp;
  } catch {
    return false;
  }
}

function duplicates(field: string, ids: readonly string[], issues: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) issues.push(`${field}: id "${id}" is used twice`);
    seen.add(id);
  }
}
