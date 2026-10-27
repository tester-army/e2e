/**
 * The CIGE field rules, checked mechanically. A repair may rewrite
 * Execution and add variants, guardrails, deny patterns, criteria, or
 * evidence; anything that weakens or redirects what a pass means blocks
 * until a human approves it: the Intent statement, a removed criterion or
 * evidence item, a judgment turned off, a guardrail or deny pattern
 * dropped, a case or variant removed, a variant's data changed, an id that
 * moves its history, any Context change (where and as whom the case runs,
 * and what it starts from), and any change to the CIGE config or a module
 * it imports, where the hooks and plugins that decide a pass live; a config
 * it can't load or follow blocks too. `e2e-cige diff` runs this over everything that
 * changed since a git ref, so CI and the `cige` skill read the same verdict.
 * App code and installed packages are out of its reach.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { CigeExtensions } from './extensions.ts';
import { parseCige, type CigeCase, type CigeEvidence } from './schema.ts';
import { fields, git, outside, treeAt, type TreeEntry, type TreeSide } from './tree.ts';

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
  | 'config-changed'
  | 'config-unverified';

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
  // A config the gate can't load, or one that imports by a computed name, hides which files decide a pass.
  'config-unverified',
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
 * What `pair` leaves unmatched: the items removed from `before` and added in
 * `after`, counted one to one, so dropping one of two entries with the same
 * key is still a removal.
 */
function unpaired<T extends { readonly id: string }>(before: readonly T[], after: readonly T[], key: (item: T) => string): { removed: T[]; added: T[] } {
  const pairs = pair(before, after, key);
  const kept = new Set(pairs.map(([was]) => was));
  const matched = new Set(pairs.map(([, now]) => now));
  return { removed: before.filter((item) => !kept.has(item)), added: after.filter((item) => !matched.has(item)) };
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
  const evidence = unpaired(before.intent.evidence, after.intent.evidence, evidenceKey);
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
  const rules = unpaired(before.guardrails, after.guardrails, (rule) => rule.rule);
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

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The files the config reaches on either side, and why that graph can't be trusted when it can't. */
interface ConfigGraph {
  /** What loading the working tree's config reached, aliases, workspace packages, and lazy imports included. */
  readonly files: readonly string[];
  /** The package.json files whose `imports` and `exports` resolved them. */
  readonly manifests: readonly string[];
  /** The merge base's config and the local modules it imports, so a deletion or a rename still counts. */
  readonly base: readonly string[];
  readonly unverified: readonly string[];
}

/** What `config-graph.ts` writes. */
const GRAPH_RESULT = z.object({ files: z.array(z.string()), manifests: z.array(z.string()), base: z.array(z.string()), unverified: z.array(z.string()) });

/** The package.json fields Node reads to resolve a module: a change to one can redirect an import with no module changed. */
const RESOLUTION_FIELDS = ['name', 'type', 'main', 'exports', 'imports'] as const;

/** A manifest's resolution fields, each canonical; undefined when the file is absent or isn't a JSON object. */
function resolutionFields(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const picked: Record<string, string> = {};
    for (const field of RESOLUTION_FIELDS) picked[field] = canonical(field in parsed ? (parsed as Record<string, unknown>)[field] : null);
    return picked;
  } catch {
    return undefined;
  }
}

/** The resolution fields that differ between two versions of a manifest, so a change elsewhere in it (scripts, dependencies) is none. */
function resolutionChanges(before: string | undefined, after: string | undefined): string[] {
  const was = resolutionFields(before);
  const now = resolutionFields(after);
  if (was === undefined || now === undefined) return was === now && before === after ? [] : ['the whole file'];
  return RESOLUTION_FIELDS.filter((field) => was[field] !== now[field]);
}

/** `config-graph.ts` beside this module: `.ts` when tests run it from source, `.js` from `dist`. */
const GRAPH_SCRIPT = fileURLToPath(new URL(`./config-graph${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/**
 * Loads the config in its own Node process and returns the files of this
 * repository it reaches, plus the merge base's side (`config-graph.ts`).
 * With no config in the working tree, only the base's side is read.
 */
function configGraph(config: string | undefined, root: string, mergeBase: string, candidates: readonly string[]): ConfigGraph {
  const scratch = mkdtempSync(path.join(tmpdir(), 'cige-graph-'));
  try {
    const inputFile = path.join(scratch, 'input.json');
    const out = path.join(scratch, 'graph.json');
    const listed = fields(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root));
    writeFileSync(inputFile, JSON.stringify({ config: config ?? null, root, mergeBase, candidates, listed }));
    try {
      execFileSync(process.execPath, ['--experimental-import-meta-resolve', '--no-warnings', GRAPH_SCRIPT, inputFile, out], {
        cwd: config === undefined ? root : path.dirname(config),
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 60_000,
      });
    } catch (cause) {
      // A string or a Buffer, or absent when the process never started.
      const stderr = String((cause as { stderr?: unknown }).stderr ?? '');
      const last = stderr.trim().split('\n').findLast((line) => line.trim() !== '');
      return { files: [], manifests: [], base: [], unverified: [`loading it failed: ${last ?? (cause instanceof Error ? cause.message : String(cause))}`] };
    }
    return GRAPH_RESULT.parse(JSON.parse(readFileSync(out, 'utf8')));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface DiffOptions {
  /**
   * Where the CIGE config may be, in order. Each side of the diff starts from
   * the first one it has, so a deleted or renamed config is still seen. Its
   * changes, and those of the local modules it imports, need a human's
   * approval like a weakened case.
   */
  readonly configFiles?: readonly string[];
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
  if (options.configFiles !== undefined && options.configFiles.length > 0) {
    // Both sides: a module deleted from the working tree is only in the base's graph, and a new one only in the working tree's.
    const root = realpathSync(top);
    const candidates = options.configFiles
      .map((file) => {
        // Through the real directory, as git reports paths, and without the file itself, which may be deleted.
        const directory = path.dirname(path.resolve(file));
        const real = existsSync(directory) ? realpathSync(directory) : directory;
        return path.relative(root, path.join(real, path.basename(file))).split(path.sep).join('/');
      })
      .filter((file) => !outside(file));
    const working: TreeSide = (file) => {
      const absolute = path.join(root, file);
      if (!existsSync(absolute) && !isLink(absolute)) return undefined;
      if (isLink(absolute)) {
        const target = existsSync(absolute) ? path.relative(root, realpathSync(absolute)).split(path.sep).join('/') : undefined;
        return { target: target === undefined || outside(target) ? undefined : target };
      }
      return isFile(absolute) ? { text: readFileSync(absolute, 'utf8') } : undefined;
    };
    const atBase = treeAt(mergeBase, top);
    const config = candidates.find((file) => isFile(path.join(root, file)));
    const graph = configGraph(config === undefined ? undefined : path.join(root, config), root, mergeBase, candidates);
    // With no config in the working tree, only a failed child reports here, and the first candidate names it: its graph is unknown, so it can't pass.
    const anchor = config ?? candidates[0];
    if (anchor !== undefined && graph.unverified.length > 0) {
      files.push({ file: anchor, changes: [change('config-unverified', `${anchor}: ${graph.unverified.join('; ')}; a human must review every change outside the case files`)] });
    }
    const modules = [...new Set([...graph.files, ...graph.base])];
    if (modules.length > 0) {
      const touched = fields(git(['diff', '--name-only', '--no-renames', '-z', mergeBase, '--', ...modules], top));
      const untracked = fields(git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...modules], top));
      for (const file of [...new Set([...touched, ...untracked])].toSorted()) {
        files.push({ file, changes: [change('config-changed', `${file}: the hooks, plugins, and environments a pass depends on`)] });
      }
    }
    const textOf = (entry: TreeEntry): string | undefined => (entry !== undefined && 'text' in entry ? entry.text : undefined);
    for (const manifest of graph.manifests.filter((file) => !modules.includes(file)).toSorted()) {
      const changedFields = resolutionChanges(textOf(atBase(manifest)), textOf(working(manifest)));
      if (changedFields.length > 0) {
        files.push({ file: manifest, changes: [change('config-changed', `${manifest}: ${changedFields.join(', ')}, which decide where the config's imports resolve`)] });
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
