/**
 * The CIGE field rules, checked mechanically. A repair may rewrite
 * Execution, adjust Context, and add variants, guardrails, deny patterns,
 * criteria, or evidence; anything that weakens what a pass means (the
 * Intent statement, a removed criterion or evidence item, a judgment turned
 * off, a guardrail or deny pattern dropped, a case or variant removed, an id
 * that moves its history) blocks until a human approves it. `e2e-cige diff`
 * runs this over every `.cige.json` that changed since a git ref, so CI and
 * the `cige` skill read the same verdict.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseCige, type CigeCase, type CigeEvidence } from './schema.ts';

/** What changed in one case, from the field rules' point of view. */
export type CigeChangeKind =
  | 'case-added'
  | 'case-removed'
  | 'invalid'
  | 'id-changed'
  | 'intent-changed'
  | 'criteria-added'
  | 'criteria-removed'
  | 'evidence-added'
  | 'evidence-removed'
  | 'judge-added'
  | 'judge-dropped'
  | 'guardrail-added'
  | 'guardrail-removed'
  | 'deny-added'
  | 'deny-removed'
  | 'execution-changed'
  | 'context-changed'
  | 'variant-added'
  | 'variant-removed'
  | 'variant-changed';

const BLOCKING: ReadonlySet<CigeChangeKind> = new Set([
  'case-removed',
  'invalid',
  'id-changed',
  'intent-changed',
  'criteria-removed',
  'evidence-removed',
  'judge-dropped',
  'guardrail-removed',
  'deny-removed',
  'variant-removed',
]);

export interface CigeChange {
  readonly kind: CigeChangeKind;
  readonly detail: string;
  /** Whether the change weakens the case, and so needs a human's approval. */
  readonly blocking: boolean;
}

function change(kind: CigeChangeKind, detail: string): CigeChange {
  return { kind, detail, blocking: BLOCKING.has(kind) };
}

/** Items of `before` missing from `after`, and of `after` missing from `before`, by key. */
function setDiff<T>(before: readonly T[], after: readonly T[], key: (item: T) => string): { removed: T[]; added: T[] } {
  const was = new Set(before.map(key));
  const now = new Set(after.map(key));
  return { removed: before.filter((item) => !now.has(key(item))), added: after.filter((item) => !was.has(key(item))) };
}

function evidenceKey(item: CigeEvidence): string {
  return item.kind === 'hook' ? `hook ${item.hook}` : `assert${item.vision === true ? ' (vision)' : ''} ${JSON.stringify(item.text)}`;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The changes from one version of a case to the next. `undefined` on one
 * side is a case added or removed.
 */
export function diffCases(before: CigeCase | undefined, after: CigeCase | undefined): CigeChange[] {
  if (before === undefined) return after === undefined ? [] : [change('case-added', after.id)];
  if (after === undefined) return [change('case-removed', before.id)];
  const changes: CigeChange[] = [];
  if (before.id !== after.id) changes.push(change('id-changed', `${before.id} -> ${after.id}; its tag and summary history move`));

  if (before.intent.statement !== after.intent.statement) {
    changes.push(change('intent-changed', `${JSON.stringify(before.intent.statement)} -> ${JSON.stringify(after.intent.statement)}`));
  }
  for (const field of ['success', 'failure'] as const) {
    const { removed, added } = setDiff(before.intent[field], after.intent[field], (line) => line);
    for (const line of removed) changes.push(change('criteria-removed', `${field}: ${JSON.stringify(line)}`));
    for (const line of added) changes.push(change('criteria-added', `${field}: ${JSON.stringify(line)}`));
  }
  const evidence = setDiff(before.intent.evidence, after.intent.evidence, evidenceKey);
  for (const item of evidence.removed) changes.push(change('evidence-removed', `${item.id}: ${evidenceKey(item)}`));
  for (const item of evidence.added) changes.push(change('evidence-added', `${item.id}: ${evidenceKey(item)}`));
  if (before.intent.judge && !after.intent.judge) changes.push(change('judge-dropped', 'the Intent is no longer judged on screen'));
  if (!before.intent.judge && after.intent.judge) changes.push(change('judge-added', 'the Intent is now judged on screen'));

  // Guardrails match by their rule text: an edited rule is the old one removed and a new one added.
  const rules = setDiff(before.guardrails, after.guardrails, (rule) => rule.rule);
  for (const rule of rules.removed) changes.push(change('guardrail-removed', `${rule.id}: ${JSON.stringify(rule.rule)}`));
  for (const rule of rules.added) changes.push(change('guardrail-added', `${rule.id}: ${JSON.stringify(rule.rule)}`));
  for (const was of before.guardrails) {
    const now = after.guardrails.find((rule) => rule.rule === was.rule);
    if (now === undefined) continue;
    for (const field of ['actions', 'summary'] as const) {
      const { removed, added } = setDiff(was.deny?.[field] ?? [], now.deny?.[field] ?? [], (entry) => entry);
      for (const entry of removed) changes.push(change('deny-removed', `${now.id}: deny.${field} ${JSON.stringify(entry)}`));
      for (const entry of added) changes.push(change('deny-added', `${now.id}: deny.${field} ${JSON.stringify(entry)}`));
    }
  }

  if (!same(before.execution, after.execution)) {
    const ids = [...new Set([...before.execution, ...after.execution].map((step) => step.id))].filter(
      (id) => !same(before.execution.find((step) => step.id === id), after.execution.find((step) => step.id === id)),
    );
    changes.push(change('execution-changed', ids.length === 0 ? 'steps reordered' : `steps ${ids.join(', ')}`));
  }
  const context = (testCase: CigeCase): unknown => ({ ...testCase.context, fragments: undefined });
  if (!same(context(before), context(after))) {
    const keys = Object.keys({ ...before.context, ...after.context }).filter(
      (key) => key !== 'fragments' && !same(before.context[key as keyof CigeCase['context']], after.context[key as keyof CigeCase['context']]),
    );
    changes.push(change('context-changed', keys.join(', ')));
  }
  const variants = setDiff(before.variants, after.variants, (variant) => variant.id);
  for (const variant of variants.removed) changes.push(change('variant-removed', variant.id));
  for (const variant of variants.added) changes.push(change('variant-added', variant.id));
  for (const was of before.variants) {
    const now = after.variants.find((variant) => variant.id === was.id);
    if (now !== undefined && !same(was, now)) changes.push(change('variant-changed', was.id));
  }
  return changes;
}

/** Whether the Intent reads exactly as it did: statement, criteria, evidence, and judgment. */
function intentUnchanged(changes: readonly CigeChange[]): boolean {
  const intentKinds: ReadonlySet<CigeChangeKind> = new Set([
    'case-removed',
    'intent-changed',
    'criteria-added',
    'criteria-removed',
    'evidence-added',
    'evidence-removed',
    'judge-added',
    'judge-dropped',
  ]);
  return !changes.some((entry) => intentKinds.has(entry.kind));
}

export interface CigeFileDiff {
  /** The file, relative to the repository root. */
  readonly file: string;
  readonly id?: string;
  readonly changes: readonly CigeChange[];
}

export interface CigeDiffReport {
  readonly base: string;
  readonly files: readonly CigeFileDiff[];
  /** True when no changed case's Intent reads differently, stricter or looser. */
  readonly intentUnchanged: boolean;
  /** How many changes weaken a case and need a human's approval. */
  readonly blocking: number;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseAt(text: string, source: string): CigeCase | CigeChange {
  try {
    return parseCige(JSON.parse(text), source);
  } catch (cause) {
    return change('invalid', `${source}: ${cause instanceof Error ? cause.message.split('\n').join(' ') : String(cause)}`);
  }
}

/**
 * Diffs every `.cige.json` that changed between `base` and the working
 * tree, untracked files included, in the repository that holds `cwd`.
 */
export function diffSince(base: string, cwd: string): CigeDiffReport {
  const top = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const lines = git(['diff', '--name-status', '--no-renames', base, '--', '*.cige.json'], top).split('\n').filter((line) => line !== '');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--full-name', '--', '*.cige.json'], top)
    .split('\n')
    .filter((line) => line !== '')
    .map((file) => `A\t${file}`);
  const files: CigeFileDiff[] = [];
  const entries = [...lines, ...untracked].map((line) => line.split('\t') as [string, string]).toSorted((a, b) => a[1].localeCompare(b[1]));
  for (const [status, file] of entries) {
    const before = status === 'A' ? undefined : parseAt(git(['show', `${base}:${file}`], top), `${base}:${file}`);
    const absolute = path.join(top, file);
    const after = status === 'D' || !existsSync(absolute) ? undefined : parseAt(readFileSync(absolute, 'utf8'), file);
    const invalid = [before, after].filter((side): side is CigeChange => side !== undefined && 'kind' in side);
    const changes =
      invalid.length > 0
        ? invalid
        : diffCases(before as CigeCase | undefined, after as CigeCase | undefined);
    const id = (after as CigeCase | undefined)?.id ?? (before as CigeCase | undefined)?.id;
    if (changes.length > 0) files.push({ file, ...(id === undefined || invalid.length > 0 ? {} : { id }), changes });
  }
  const all = files.flatMap((entry) => entry.changes);
  return { base, files, intentUnchanged: intentUnchanged(all), blocking: all.filter((entry) => entry.blocking).length };
}

/** The report as the terminal shows it: one line per change, blocking ones marked. */
export function formatDiff(report: CigeDiffReport): string {
  if (report.files.length === 0) return `No CIGE case changed since ${report.base}.\n`;
  const lines: string[] = [];
  for (const entry of report.files) {
    lines.push(`${entry.file}${entry.id === undefined ? '' : ` (${entry.id})`}`);
    for (const item of entry.changes) lines.push(`  ${item.blocking ? 'needs approval' : 'ok            '}  ${item.kind}: ${item.detail}`);
  }
  lines.push('');
  lines.push(
    report.blocking === 0
      ? `Every change keeps or tightens what a pass means. Intent ${report.intentUnchanged ? 'unchanged' : 'tightened'}.`
      : `${report.blocking} change${report.blocking === 1 ? '' : 's'} weaken${report.blocking === 1 ? 's' : ''} a case and need${report.blocking === 1 ? 's' : ''} a human's approval.`,
  );
  return `${lines.join('\n')}\n`;
}
