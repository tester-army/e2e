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
const Context = z.strictObject({
  system: Text.optional(),
  environment: Text.optional(),
  actor: Text.optional(),
  agent: z.union([Id, z.array(Id).min(1)]).optional(),
  open: Text.optional(),
  tools: z.array(Text).optional(),
  preconditions: z.array(z.union([Text, PreconditionHook])).optional(),
  facts: z.array(Text).optional(),
  prompts: z.array(Text).optional(),
  specRef: Text.optional(),
  buildRef: Text.optional(),
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
  readonly environment?: string;
  readonly actor?: string;
  readonly agent?: string | readonly string[];
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

const FIELDS = ['Context', 'Intent', 'Guardrails', 'Execution'] as const;

/** Maps the paper's lowercase field names onto the capitalized ones, refusing a file that spells one field both ways. */
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

  const judge = intentObject.judge ?? true;
  duplicates('Execution', execution.map((step) => step.id), issues);
  duplicates('Guardrails', guardrails.map((rule) => rule.id), issues);
  duplicates('Intent.evidence', evidence.map((item) => item.id), issues);
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
      ...(context.open === undefined ? {} : { open: context.open }),
      tools: context.tools ?? [],
      preconditions,
      facts: context.facts ?? [],
      prompts: context.prompts ?? [],
      fragments: [],
      ...(context.specRef === undefined ? {} : { specRef: context.specRef }),
      ...(context.buildRef === undefined ? {} : { buildRef: context.buildRef }),
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
  };
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
