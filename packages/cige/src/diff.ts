/**
 * The CIGE field rules, checked mechanically. A repair may rewrite
 * Execution and add variants, guardrails, deny patterns, criteria, or
 * evidence; anything that weakens or redirects what a pass means blocks
 * until a human approves it: the Intent statement, a removed criterion or
 * evidence item, a judgment turned off, a guardrail or deny pattern
 * dropped, a case or variant removed, a variant's data changed, an id that
 * moves its history, any Context change (where and as whom the case runs,
 * and what it starts from), and any change to the CIGE config or the local
 * modules it imports, where the hooks and plugins that decide a pass live.
 * `e2e-cige diff` runs this over everything that changed since a git ref,
 * so CI and the `cige` skill read the same verdict. App code and packages
 * are out of its reach.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { CigeExtensions } from './extensions.ts';
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
  | 'variant-changed'
  | 'intent-extension-changed'
  | 'guardrail-extension-changed'
  | 'case-extension-changed'
  | 'config-changed';

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
  'variant-changed',
  // Context says where, as whom, and from what state the case runs: switching the environment or the agent,
  // or dropping a precondition, can make a case pass that should not.
  'context-changed',
  // The config holds the hooks and plugins a pass depends on: an evidence hook rewritten to return true is a pass.
  'config-changed',
  // Intent is human-owned, and a plugin may enforce a guardrail's x- data, so changing either can loosen the case.
  'intent-extension-changed',
  'guardrail-extension-changed',
]);

export interface CigeChange {
  readonly kind: CigeChangeKind;
  readonly detail: string;
  /** Whether the change can weaken or redirect what a pass means, and so needs a human's approval. */
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

/** `value` as JSON with object keys sorted, so reordering keys is no change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** The `x-` keys whose values differ between two versions of one object. */
function changedKeys(before: CigeExtensions | undefined, after: CigeExtensions | undefined): string[] {
  return Object.keys({ ...before, ...after }).filter((key) => !same(before?.[key], after?.[key]));
}

/**
 * Entries of `before` and `after` that are the same entry, one to one: equal
 * by `key`, the same id first, so a second guardrail or evidence item with
 * the same text is compared with its own counterpart, not the first one.
 */
function pair<T extends { readonly id: string }>(before: readonly T[], after: readonly T[], key: (item: T) => string): [T, T][] {
  const used = new Set<T>();
  const pairs: [T, T][] = [];
  for (const was of before) {
    const candidates = after.filter((item) => !used.has(item) && key(item) === key(was));
    const now = candidates.find((item) => item.id === was.id) ?? candidates[0];
    if (now === undefined) continue;
    used.add(now);
    pairs.push([was, now]);
  }
  return pairs;
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
  const intentKeys = changedKeys(before.intent.extensions, after.intent.extensions);
  if (intentKeys.length > 0) changes.push(change('intent-extension-changed', `Intent ${intentKeys.join(', ')}`));
  for (const [was, now] of pair(before.intent.evidence, after.intent.evidence, evidenceKey)) {
    const keys = changedKeys(was.extensions, now.extensions);
    if (keys.length > 0) changes.push(change('intent-extension-changed', `${now.id}: ${keys.join(', ')}`));
  }
  if (!before.intent.judge && after.intent.judge) changes.push(change('judge-added', 'the Intent is now judged on screen'));

  // Guardrails match by their rule text: an edited rule is the old one removed and a new one added.
  const rules = setDiff(before.guardrails, after.guardrails, (rule) => rule.rule);
  for (const rule of rules.removed) changes.push(change('guardrail-removed', `${rule.id}: ${JSON.stringify(rule.rule)}`));
  for (const rule of rules.added) changes.push(change('guardrail-added', `${rule.id}: ${JSON.stringify(rule.rule)}`));
  for (const [was, now] of pair(before.guardrails, after.guardrails, (rule) => rule.rule)) {
    const keys = [...changedKeys(was.extensions, now.extensions), ...changedKeys(was.deny?.extensions, now.deny?.extensions).map((key) => `deny.${key}`)];
    if (keys.length > 0) changes.push(change('guardrail-extension-changed', `${now.id}: ${keys.join(', ')}`));
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
    const dropped = setDiff(before.context.preconditions, after.context.preconditions, (entry) => canonical(entry)).removed.map((entry) =>
      entry.kind === 'hook' ? `hook ${entry.hook}` : JSON.stringify(entry.text),
    );
    changes.push(change('context-changed', [keys.join(', '), ...(dropped.length === 0 ? [] : [`precondition removed: ${dropped.join(', ')}`])].join('; ')));
  }
  // Top-level x- keys are triage data (an owner, a ticket); enforced data belongs on a guardrail, whose x- changes block.
  const caseKeys = changedKeys(before.extensions, after.extensions);
  if (caseKeys.length > 0) changes.push(change('case-extension-changed', caseKeys.join(', ')));
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
    'intent-extension-changed',
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
  /** How many changes need a human's approval. */
  readonly blocking: number;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** NUL-separated fields of `git ... -z` output: paths arrive unquoted, whatever characters they hold. */
function fields(output: string): string[] {
  return output.split('\0').filter((field) => field !== '');
}

/** One side of a file's diff: the parsed case, or the change that says it doesn't parse. */
type Side = { readonly testCase: CigeCase } | { readonly invalid: CigeChange };

function parseAt(text: string, source: string): Side {
  try {
    return { testCase: parseCige(JSON.parse(text), source) };
  } catch (cause) {
    return { invalid: change('invalid', `${source}: ${cause instanceof Error ? cause.message.split('\n').join(' ') : String(cause)}`) };
  }
}

function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const MODULE_EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];

/**
 * The CIGE config file and every local module it imports, transitively:
 * static and dynamic imports whose specifier starts with `.`, resolved
 * beside the importing file, inside the repository only. Packages are not
 * followed; they are reviewed as dependencies, not as the case.
 */
function configModules(configFile: string, top: string): string[] {
  // Real paths on both sides: git reports the repository's, and a path through a symlink would land outside it.
  const root = realpathSync(top);
  const seen = new Set<string>();
  const visit = (candidate: string): void => {
    if (!isFile(candidate)) return;
    const file = realpathSync(candidate);
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const target = path.resolve(path.dirname(file), match[1]!);
      const resolved = MODULE_EXTENSIONS.map((extension) => `${target}${extension}`).find(isFile);
      if (resolved !== undefined && !path.relative(root, realpathSync(resolved)).startsWith('..')) visit(resolved);
    }
  };
  visit(path.resolve(configFile));
  return [...seen].filter((file) => !path.relative(root, file).startsWith('..')).map((file) => path.relative(root, file).split(path.sep).join('/'));
}

export interface DiffOptions {
  /** The CIGE config file; its changes, and those of the local modules it imports, need a human's approval like a weakened case. */
  readonly configFile?: string;
}

/**
 * Diffs every `.cige.json` that changed since this branch left `base` (their
 * merge base) up to the working tree, untracked files included, in the
 * repository that holds `cwd`, and reports any change to the CIGE config and
 * the local modules it imports.
 */
export function diffSince(base: string, cwd: string, options: DiffOptions = {}): CigeDiffReport {
  const top = git(['rev-parse', '--show-toplevel'], cwd).trim();
  // From where this branch left the base, not its tip: a change that landed there since is not this branch's.
  const mergeBase = git(['merge-base', base, 'HEAD'], top).trim();
  // `--name-status -z` alternates status and path.
  const changed = fields(git(['diff', '--name-status', '--no-renames', '-z', mergeBase, '--', '*.cige.json'], top));
  const entries: [string, string][] = [];
  for (let index = 0; index + 1 < changed.length; index += 2) entries.push([changed[index]!, changed[index + 1]!]);
  for (const file of fields(git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '*.cige.json'], top))) {
    entries.push(['A', file]);
  }
  const files: CigeFileDiff[] = [];
  for (const [status, file] of entries.toSorted((a, b) => a[1].localeCompare(b[1]))) {
    const before = status === 'A' ? undefined : parseAt(git(['show', `${mergeBase}:${file}`], top), `${base}:${file}`);
    const absolute = path.join(top, file);
    const after = status === 'D' || !existsSync(absolute) ? undefined : parseAt(readFileSync(absolute, 'utf8'), file);
    const invalid = [before, after].flatMap((side) => (side !== undefined && 'invalid' in side ? [side.invalid] : []));
    const caseOf = (side: Side | undefined): CigeCase | undefined => (side !== undefined && 'testCase' in side ? side.testCase : undefined);
    const changes = invalid.length > 0 ? invalid : diffCases(caseOf(before), caseOf(after));
    const id = caseOf(after)?.id ?? caseOf(before)?.id;
    if (changes.length > 0) files.push({ file, ...(id === undefined || invalid.length > 0 ? {} : { id }), changes });
  }
  if (options.configFile !== undefined) {
    const modules = configModules(options.configFile, top);
    if (modules.length > 0) {
      const touched = fields(git(['diff', '--name-only', '--no-renames', '-z', mergeBase, '--', ...modules], top));
      const untracked = fields(git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...modules], top));
      for (const file of [...new Set([...touched, ...untracked])].toSorted()) {
        files.push({ file, changes: [change('config-changed', `${file}: the hooks, plugins, and environments a pass depends on`)] });
      }
    }
  }
  const all = files.flatMap((entry) => entry.changes);
  return { base, files, intentUnchanged: intentUnchanged(all), blocking: all.filter((entry) => entry.blocking).length };
}

/** The report as the terminal shows it: one line per change, blocking ones marked. */
export function formatDiff(report: CigeDiffReport): string {
  if (report.files.length === 0) return `No CIGE case or config changed since ${report.base}.\n`;
  const lines: string[] = [];
  for (const entry of report.files) {
    lines.push(`${entry.file}${entry.id === undefined ? '' : ` (${entry.id})`}`);
    for (const item of entry.changes) lines.push(`  ${item.blocking ? 'needs approval' : 'ok            '}  ${item.kind}: ${item.detail}`);
  }
  lines.push('');
  lines.push(
    report.blocking === 0
      ? `Every change keeps or tightens what a pass means. Intent ${report.intentUnchanged ? 'unchanged' : 'tightened'}.`
      : `${report.blocking} change${report.blocking === 1 ? '' : 's'} can change what a pass means and need${report.blocking === 1 ? 's' : ''} a human's approval.`,
  );
  return `${lines.join('\n')}\n`;
}
