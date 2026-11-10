/**
 * `e2e compile`: turns the `agent.act()` steps a run recorded into the test
 * lines that repeat them, in place in the test file, and the subcommands
 * around it:
 *
 * - `e2e compile [files...]` compiles. The recordings are the replay
 *   cache's `trace-1` entries; a selected step with none is recorded first
 *   by running its test (`e2e run <file:line>`), unless `--no-run`. Without
 *   `--write`, the change is printed and nothing is edited.
 * - `e2e compile status [files...]` says, for every step, whether it
 *   compiles and, when not, why, as a code; whether a compiled block's
 *   recording has been replaced since; what a test id would unlock; and the
 *   coverage. It never runs a test or edits a file.
 * - `e2e compile revert <file[:line]>...` puts compiled blocks back as the
 *   statements they were compiled from.
 *
 * A step is replaced only when its recording is pinned to it beyond doubt:
 * a literal instruction in a bare statement of the test's own callback, the
 * test declared once at its line, params the source spells out and the
 * recording's key digests alike, one agent, and as many recordings of that
 * call as calls. Conservative by default: a target with no test id leaves
 * its step to the agent (`unverified-locator`) unless `--loose`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import picocolors from 'picocolors';
import { z } from 'zod';
import { projectIdentity } from '../cache/identity.ts';
import { REPLAY_POLICY_VERSION } from '../cache/relocate.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../cache/store.ts';
import { MAX_TRACE_DESCRIPTOR_CHARS, TRACE_SCHEMA_VERSION, targetLabel, type ActionTrace, type TraceTargetDescriptor } from '../cache/trace.ts';
import { collect, type CollectedTest } from '../collect/collect.ts';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { isCiMode, resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { errorMessage } from '../internal/errors.ts';
import { escapeRegexpChar } from '../internal/regexp.ts';
import { bound } from '../internal/text.ts';
import { cliEntry } from '../mcp/run-tests.ts';
import { compileTrace, type CompileFills, type CompiledStep, type CompileResult, type RefusalCode } from './lines.ts';
import { digestParams } from './params.ts';
import { SourceFile, type ActSite, type CompiledBlock, type TestSource } from './sites.ts';

/** How many characters of a key hash or a digest a compiled block keeps. */
const SHORT = 12;

/** Why a call in the source cannot take a recording, beside the codes a recording's own refusal carries. */
type PlacementCode =
  | 'not-recorded'
  | 'loop-declared'
  | 'dynamic-instruction'
  | 'dynamic-params'
  | 'nested-call'
  | 'step-options'
  | 'ambiguous-recording'
  | 'group-partial'
  | 'not-in-body'
  | 'fixtures'
  | 'verify-failed';

type Code = RefusalCode | PlacementCode;

/** What every subcommand reads its config with. */
interface CommonOptions {
  readonly config?: string;
  readonly target?: string;
  readonly cacheDir?: string;
  readonly cwd?: string;
}

export interface CompileOptions extends CommonOptions {
  readonly files: readonly string[];
  /** Rewrite the test files; otherwise print what would change. */
  readonly write?: boolean;
  /** Record missing steps by running their tests first. Default true. */
  readonly run?: boolean;
  /** Compile targets with no test id, and calls whose params the source does not spell out, too. */
  readonly loose?: boolean;
  /** After writing, run each compiled test once and put back the blocks of every test that did not pass. */
  readonly verify?: boolean;
}

export interface StatusOptions extends CommonOptions {
  readonly files: readonly string[];
  readonly loose?: boolean;
  readonly json?: boolean;
}

export interface RevertOptions extends CommonOptions {
  readonly locations: readonly string[];
  readonly write?: boolean;
}

/** One recording, newest per step. */
interface Recording {
  readonly keyHash: string;
  readonly createdAt: string;
  readonly trace: ActionTrace;
}

/** What became of one `agent.act()` call. */
type Outcome =
  | { readonly kind: 'compiled'; readonly site: ActSite; readonly step: CompiledStep; readonly recording: Recording; readonly unverified: readonly TraceTargetDescriptor[] }
  | { readonly kind: 'missing'; readonly site: ActSite }
  | { readonly kind: 'skipped'; readonly site: ActSite; readonly code: Code; readonly reason: string; readonly unverified: readonly TraceTargetDescriptor[] };

/** One selected test: its source, its calls' outcomes, its compiled blocks, and its recordings. */
interface TestPlan {
  readonly test: CollectedTest;
  readonly testSource: TestSource | undefined;
  readonly outcomes: readonly Outcome[];
  readonly blocks: readonly CompiledBlock[];
  readonly recordings: readonly Recording[];
  /** Set when no call of the test can be pinned, whatever its recordings say. */
  readonly placement?: { readonly code: PlacementCode; readonly reason: string };
}

/** What compiling any step of this command needs beyond its recording. */
interface PlanContext {
  readonly fills: CompileFills;
  readonly appBase: { readonly href: string; readonly origin: string } | undefined;
  readonly loose: boolean;
  /** Each secret's purpose by name, and each credential's username: what a params digest projects them to. */
  readonly secretPurposes: ReadonlyMap<string, string>;
  readonly usernames: ReadonlyMap<string, string>;
}

/** One source edit: replace `[start, end)` with `text`. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The resolved project a subcommand works in. */
interface Project {
  readonly config: ResolvedConfig;
  readonly targetName: string;
  readonly context: PlanContext;
  readonly sourceOf: (file: string) => Promise<SourceFile>;
}

/** Loads the config and picks the target; a string is the error to print. */
async function openProject(options: CommonOptions & { readonly loose?: boolean }): Promise<Project | string> {
  const cwd = options.cwd ?? process.cwd();
  let config: ResolvedConfig;
  try {
    const discovered = discoverConfig(cwd, options.config);
    if (discovered.configPath === undefined) throw missingConfigError(cwd);
    const raw = await loadConfigModule(discovered.configPath);
    config = resolveConfig(raw, {
      projectRoot: discovered.projectRoot,
      configPath: discovered.configPath,
      env: process.env,
      cli: options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
    });
  } catch (cause) {
    return errorMessage(cause);
  }
  if (config.cache.store !== undefined) return 'cache.store replaces the file store; e2e compile reads recordings from files only';
  const names = config.targets.map((target) => target.name);
  let targetName: string;
  if (options.target !== undefined) {
    if (!names.includes(options.target)) return `no target "${options.target}"; the config has ${names.join(', ')}`;
    targetName = options.target;
  } else if (names.length === 1) targetName = names[0]!;
  else return `the config has ${String(names.length)} targets (${names.join(', ')}); name the one whose recordings to compile with --target`;
  const target = config.targets.find((candidate) => candidate.name === targetName)!;
  const credentials = [...config.credentials.values()];
  const sources = new Map<string, SourceFile>();
  const sourceOf = async (file: string): Promise<SourceFile> => {
    let source = sources.get(file);
    if (source === undefined) {
      source = new SourceFile(file, await readFile(path.join(config.projectRoot, file), 'utf8'));
      sources.set(file, source);
    }
    return source;
  };
  return {
    config,
    targetName,
    context: {
      fills: {
        credentials: credentials.map((credential) => ({ name: credential.name, username: credential.username, password: credential.password.name })),
        secrets: [...config.secrets.keys()],
      },
      appBase: target.app.base,
      loose: options.loose === true,
      secretPurposes: new Map([...config.allSecrets].map(([name, secret]) => [name, secret.purpose])),
      usernames: new Map(credentials.map((credential) => [credential.name, credential.username])),
    },
    sourceOf,
  };
}

/** The selected tests, or the error to print. */
async function selectTests(project: Project, files: readonly string[]): Promise<readonly CollectedTest[] | string> {
  const collection = await collect(project.config, files);
  const tests = collection.tests.filter((test) => test.selected && test.kind === 'test');
  return tests.length === 0 ? `no tests selected${files.length === 0 ? '' : ` by ${files.join(' ')}`}` : tests;
}

/** Runs `e2e compile`; returns the exit code. */
export async function compileCommand(options: CompileOptions): Promise<number> {
  const project = await openProject(options);
  if (typeof project === 'string') return fail(project);
  const tests = await selectTests(project, options.files);
  if (typeof tests === 'string') return fail(tests);
  const { config, targetName } = project;

  let plans = await planAll(project, tests, await readRecordings(config, targetName));
  const missing = [...new Set(plans.flatMap(({ test, outcomes }) => (outcomes.some((outcome) => outcome.kind === 'missing') ? [declaration(test)] : [])))];
  if (missing.length > 0 && options.run !== false) {
    if (isCiMode(process.env) && config.cache.mode !== 'read-write') {
      process.stderr.write(picocolors.yellow(`CI is set and the cache is ${config.cache.mode}: the run below records nothing. Set cache.mode to read-write to record in CI.\n`));
    }
    process.stdout.write(`${picocolors.bold('Recording')} ${String(missing.length)} test(s) with no recording yet: e2e run ${missing.join(' ')}\n\n`);
    await runTests(config, targetName, missing, options);
    plans = await planAll(project, tests, await readRecordings(config, targetName));
    process.stdout.write('\n');
  }

  const compiledOn = today();
  const editsByFile = new Map<string, Edit[]>();
  const importNeeds = new Map<string, Set<string>>();
  /** Each test compiled here, with the recordings its blocks name, for `--verify` to find them again. */
  const written: { readonly test: CollectedTest; readonly recordings: ReadonlySet<string> }[] = [];
  let compiled = 0;
  let left = 0;
  for (const plan of plans) {
    const { test, testSource, outcomes } = plan;
    if (outcomes.length === 0 && plan.placement === undefined) continue;
    process.stdout.write(`${picocolors.bold(test.titlePath.join(' › '))} ${picocolors.dim(declaration(test))}\n`);
    if (plan.placement !== undefined) {
      left += Math.max(1, plan.recordings.length);
      process.stdout.write(`  ${skipMark()} ${codeLabel(plan.placement.code)} ${plan.placement.reason}\n`);
      continue;
    }
    const source = await project.sourceOf(test.file);
    const fixturesNeeded = new Set<string>();
    const importsNeeded = new Set<string>();
    const edits: Edit[] = [];
    for (const outcome of outcomes) {
      const label = siteLabel(outcome.site);
      if (outcome.kind === 'missing') {
        left += 1;
        const why =
          options.run === false
            ? 'no recording; run the test first, or drop --no-run'
            : 'no recording: the run did not pass this step, or the cache saved nothing for it (a step that ends where it began, or with no action to replay; see "not saved" in the run summary)';
        process.stdout.write(`  ${skipMark()} ${label} ${codeLabel('not-recorded')} ${why}\n`);
        continue;
      }
      if (outcome.kind === 'skipped') {
        left += 1;
        process.stdout.write(`  ${skipMark()} ${label} ${codeLabel(outcome.code)} ${outcome.reason}\n`);
        continue;
      }
      compiled += 1;
      const { site, step, recording } = outcome;
      const guessed = outcome.unverified.length > 0 ? picocolors.yellow(` (${String(outcome.unverified.length)} unverified locator(s))`) : '';
      process.stdout.write(`  ${picocolors.green('✓')} ${label} → ${String(step.actions)} action(s), ${String(step.assertions)} assertion(s)${guessed}\n`);
      for (const fixture of step.fixtures) fixturesNeeded.add(fixture);
      for (const name of step.imports) importsNeeded.add(name);
      edits.push({ start: site.start, end: site.end, text: blockText(site, step, recording, compiledOn, source.eol) });
    }
    if (edits.length === 0 || testSource === undefined) continue;
    const bindings = bindingEdits(source, testSource, fixturesNeeded, importsNeeded);
    if (typeof bindings === 'string') {
      process.stdout.write(`  ${skipMark()} ${codeLabel('fixtures')} ${bindings}; left unchanged\n`);
      compiled -= edits.length;
      left += edits.length;
      continue;
    }
    written.push({
      test,
      recordings: new Set(outcomes.flatMap((outcome) => (outcome.kind === 'compiled' ? [outcome.recording.keyHash.slice(0, SHORT)] : []))),
    });
    edits.push(...bindings.fixtures);
    const list = editsByFile.get(test.file) ?? [];
    list.push(...edits);
    editsByFile.set(test.file, list);
    for (const name of bindings.imports) (importNeeds.get(test.file) ?? importNeeds.set(test.file, new Set()).get(test.file)!).add(name);
  }

  for (const [file, edits] of editsByFile) {
    const source = await project.sourceOf(file);
    const names = [...(importNeeds.get(file) ?? [])];
    if (names.length > 0) {
      const existing = source.e2eImport();
      const at = existing?.insert ?? source.afterImports();
      edits.push({ start: at, end: at, text: existing === undefined ? `${source.eol}import { ${names.join(', ')} } from 'e2e';` : names.map((name) => `, ${name}`).join('') });
    }
    await emit(config.projectRoot, file, source.text, applyEdits(source.text, edits), options.write === true);
  }

  if (options.verify === true && options.write === true && written.length > 0) {
    const reverted = await verifyCompiled(project, written, options);
    compiled -= reverted;
    left += reverted;
  }

  const verb = options.write === true ? 'compiled' : 'would compile';
  process.stdout.write(`\n${picocolors.bold(`${String(compiled)} step(s) ${verb}`)}, ${String(left)} left to the agent${options.write === true || compiled === 0 ? '' : '; pass --write to change the files'}\n`);
  if (left > 0) process.stdout.write(picocolors.dim('Why each one stays, and what would unlock it: e2e compile status\n'));
  return 0;
}

/**
 * A compiled block: a JSDoc comment naming the statement it replaces (as a
 * JSON string, `*\/` escaped so the comment stays closed), the recording, and
 * when both happened; the lines; and the end comment.
 */
function blockText(site: ActSite, step: CompiledStep, recording: Recording, compiledOn: string, eol: string): string {
  const recordedFor = recording.trace.recordedFor;
  const stepTag = recordedFor === undefined ? undefined : `${recordedFor.instructionDigest.slice(0, SHORT)}.${(recordedFor.paramsDigest ?? '').slice(0, SHORT)}`;
  const tags = [
    `@compiled agent.act(${JSON.stringify(bound(site.instruction ?? '', 80)).replaceAll('*/', '*\\/')})`,
    `@from ${JSON.stringify(site.source).replaceAll('*/', '*\\/')}`,
    `@recording ${recording.keyHash.slice(0, SHORT)}`,
    ...(stepTag === undefined ? [] : [`@step ${stepTag}`]),
    `@recordedAt ${recording.createdAt.slice(0, 10)}`,
    `@compiledAt ${compiledOn}`,
  ];
  const lines = ['/**', ...tags.map((tag) => ` * ${tag}`), ' */', ...step.lines, '/** @end compiled */'];
  return lines.join(`${eol}${site.indent}`);
}

/**
 * The fixtures to add to the callback's pattern and the names to import from
 * `e2e`, or why the lines cannot have the names they use: a fixture bound
 * under another name, a pattern that gathers the rest, or a name the module
 * or the callback declares itself. A name the file already imports, from
 * `e2e` or from a module that re-exports it, is used as imported.
 */
function bindingEdits(
  source: SourceFile,
  testSource: TestSource,
  fixtures: ReadonlySet<string>,
  imports: ReadonlySet<string>,
): { readonly fixtures: readonly Edit[]; readonly imports: readonly string[] } | string {
  const locals = new Map([...testSource.fixtures].map(([key, local]) => [local, key]));
  const added: string[] = [];
  for (const fixture of fixtures) {
    const local = testSource.fixtures.get(fixture);
    if (local === fixture) continue;
    if (local !== undefined) return `the callback names the ${fixture} fixture ${local}, and the lines use ${fixture}`;
    if (locals.has(fixture)) return `the callback binds ${fixture} to the ${locals.get(fixture)!} fixture`;
    if (testSource.bodyNames.has(fixture)) return `the callback declares its own ${fixture}, and the lines use the fixture`;
    if (testSource.fixtureRest || testSource.fixtureInsert === undefined) return `the callback does not destructure its fixtures in a way ${fixture} can be added to`;
    added.push(fixture);
  }
  const imported = source.importedNames();
  const declared = source.moduleNames();
  const toImport: string[] = [];
  for (const name of imports) {
    if (testSource.bodyNames.has(name)) return `the callback declares its own ${name}, and the lines use e2e's`;
    // An import of the name (e2e's, or a project's fixtures module re-exporting it) is the binding the
    // rest of the test already uses, so the lines use it too; --verify catches one that differs.
    if (imported.has(name)) continue;
    if (declared.has(name)) return `the module declares its own ${name}, and the lines use e2e's`;
    toImport.push(name);
  }
  const at = testSource.fixtureInsert;
  return { fixtures: added.length === 0 || at === undefined ? [] : [{ start: at, end: at, text: added.map((fixture) => `, ${fixture}`).join('') }], imports: toImport };
}

/** One recorded step as `status` reports it. */
interface StatusRow {
  readonly test: string;
  readonly location: string;
  readonly instruction: string | undefined;
  readonly status: 'compiles' | 'compiled' | 'stale' | 'stays' | 'not-recorded';
  readonly code: Code | undefined;
  readonly reason: string | undefined;
  readonly unverified: readonly string[];
}

/** Runs `e2e compile status`; returns the exit code. */
export async function statusCommand(options: StatusOptions): Promise<number> {
  const project = await openProject(options);
  if (typeof project === 'string') return fail(project);
  const tests = await selectTests(project, options.files);
  if (typeof tests === 'string') return fail(tests);
  const plans = await planAll(project, tests, await readRecordings(project.config, project.targetName));

  const rows: StatusRow[] = [];
  // Targets without a test id, with the steps each blocks: a step counts only when ids are all it lacks.
  const unlocks = new Map<string, { label: string; steps: Set<string> }>();
  const noteUnverified = (key: string, unverified: readonly TraceTargetDescriptor[], onlyIds: boolean): void => {
    for (const target of unverified) {
      const label = `${targetLabel(target)}${target.within === undefined ? '' : ` in "${target.within}"`}`;
      const entry = unlocks.get(label) ?? { label, steps: new Set<string>() };
      if (onlyIds) entry.steps.add(key);
      unlocks.set(label, entry);
    }
  };

  for (const plan of plans) {
    const { test } = plan;
    const name = test.titlePath.join(' › ');
    for (const block of plan.blocks) rows.push(blockRow(name, `${test.file}:${String(block.line)}`, block, plan.recordings));
    if (plan.placement !== undefined) {
      // No call to pin: report each recording as it would compile, under the placement's code.
      for (const recording of plan.recordings) {
        const result = compileTrace(recording.trace, { ...project.context, uniques: new Map() });
        rows.push({
          test: name,
          location: declaration(test),
          instruction: undefined,
          status: 'stays',
          code: plan.placement.code,
          reason: `${plan.placement.reason}; the recording ${result.ok ? 'would compile' : `would stay: [${result.code}]`}`,
          unverified: result.unverified.map((target) => targetLabel(target)),
        });
        noteUnverified(`${test.id}#${recording.keyHash}`, result.unverified, false);
      }
      if (plan.recordings.length === 0) rows.push({ test: name, location: declaration(test), instruction: undefined, status: 'stays', code: plan.placement.code, reason: plan.placement.reason, unverified: [] });
      continue;
    }
    for (const outcome of plan.outcomes) {
      const location = `${test.file}:${String(outcome.site.line)}`;
      const base = { test: name, location, instruction: outcome.site.instruction };
      if (outcome.kind === 'missing') {
        rows.push({ ...base, status: 'not-recorded', code: 'not-recorded', reason: 'no recording yet; e2e compile records it by running the test', unverified: [] });
      } else if (outcome.kind === 'compiled') {
        rows.push({ ...base, status: 'compiles', code: undefined, reason: undefined, unverified: outcome.unverified.map((target) => targetLabel(target)) });
      } else {
        rows.push({ ...base, status: 'stays', code: outcome.code, reason: outcome.reason, unverified: outcome.unverified.map((target) => targetLabel(target)) });
        noteUnverified(`${test.id}@${location}`, outcome.unverified, outcome.code === 'unverified-locator');
      }
    }
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.code ?? row.status;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const done = rows.filter((row) => row.status === 'compiles' || row.status === 'compiled').length;
  const suggestions = [...unlocks.values()].filter((entry) => entry.steps.size > 0).toSorted((a, b) => b.steps.size - a.steps.size);

  if (options.json === true) {
    const summary = {
      steps: rows.length,
      compiles: rows.filter((row) => row.status === 'compiles').length,
      compiled: rows.filter((row) => row.status === 'compiled').length,
      stale: rows.filter((row) => row.status === 'stale').length,
      byCode: Object.fromEntries(counts),
      loose: project.context.loose,
    };
    process.stdout.write(`${JSON.stringify({ summary, steps: rows, testIds: suggestions.map((entry) => ({ target: entry.label, unlocks: entry.steps.size })) }, null, 2)}\n`);
    return 0;
  }

  let lastTest = '';
  for (const row of rows) {
    if (row.test !== lastTest) {
      process.stdout.write(`${picocolors.bold(row.test)} ${picocolors.dim(row.location.replace(/:\d+$/u, ''))}\n`);
      lastTest = row.test;
    }
    const where = picocolors.dim(row.location.slice(row.location.lastIndexOf(':') + 1).padStart(4));
    const what = row.instruction === undefined ? '' : ` ${JSON.stringify(row.instruction)}`;
    if (row.status === 'compiles' || row.status === 'compiled') {
      const guessed = row.unverified.length > 0 ? picocolors.yellow(` · unverified: ${row.unverified.join(', ')}`) : '';
      process.stdout.write(`  ${picocolors.green('✓')} L${where}${what}${row.reason === undefined ? '' : ` ${picocolors.dim(row.reason)}`}${guessed}\n`);
    } else if (row.status === 'stale') {
      process.stdout.write(`  ${picocolors.yellow('!')} L${where}${what} ${codeLabel('stale')} ${picocolors.dim(row.reason ?? '')}\n`);
    } else {
      process.stdout.write(`  ${skipMark()} L${where}${what} ${codeLabel(row.code!)} ${picocolors.dim(row.reason ?? '')}\n`);
    }
  }
  process.stdout.write(`\n${picocolors.bold('Coverage')} ${String(done)} of ${String(rows.length)} step(s) compiled or compile${project.context.loose ? ' (--loose)' : ''}\n`);
  for (const [code, count] of [...counts].toSorted((a, b) => b[1] - a[1])) process.stdout.write(`  ${String(count).padStart(3)} ${codeLabel(code)}\n`);
  if (suggestions.length > 0) {
    process.stdout.write(`\n${picocolors.bold('Test ids that would unlock steps')}\n`);
    for (const entry of suggestions.slice(0, 15)) process.stdout.write(`  ${String(entry.steps.size).padStart(3)} step(s) · ${entry.label}\n`);
  }
  return 0;
}

/** A compiled block as `status` reports it: current, or stale once its step was recorded again. */
function blockRow(test: string, location: string, block: CompiledBlock, recordings: readonly Recording[]): StatusRow {
  const when = `compiled ${block.compiledAt ?? '?'} from rec ${block.recording ?? '?'} (recorded ${block.recordedAt ?? '?'})${block.verifiedAt === undefined ? '' : `, verified ${block.verifiedAt}`}`;
  const [instruction = '', params = ''] = (block.step ?? '').split('.');
  const newer =
    instruction === ''
      ? undefined
      : recordings.find(
          (recording) =>
            recording.trace.recordedFor?.instructionDigest.startsWith(instruction) === true &&
            (recording.trace.recordedFor.paramsDigest ?? '').startsWith(params) &&
            !recording.keyHash.startsWith(block.recording ?? '\u0000') &&
            recording.createdAt.slice(0, 10) > (block.recordedAt ?? ''),
        );
  if (newer === undefined) return { test, location, instruction: undefined, status: 'compiled', code: undefined, reason: when, unverified: [] };
  return {
    test,
    location,
    instruction: undefined,
    status: 'stale',
    code: undefined,
    reason: `${when}; the step was recorded again on ${newer.createdAt.slice(0, 10)} (rec ${newer.keyHash.slice(0, SHORT)}): revert and compile it again to take it`,
    unverified: [],
  };
}

/** Runs `e2e compile revert`; returns the exit code. */
export async function revertCommand(options: RevertOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const root = discoverConfig(cwd, options.config).projectRoot;
  const byFile = new Map<string, number[] | 'all'>();
  for (const location of options.locations) {
    const match = /^(.*?)(?::(\d+))?$/u.exec(location)!;
    const file = match[1]!;
    const absolute = path.isAbsolute(file) ? file : existsSync(path.resolve(cwd, file)) ? path.resolve(cwd, file) : path.resolve(root, file);
    if (!existsSync(absolute)) return fail(`no file ${file}`);
    const lines = match[2] === undefined ? 'all' : [Number(match[2])];
    const seen = byFile.get(absolute);
    byFile.set(absolute, seen === 'all' || lines === 'all' ? 'all' : [...(seen ?? []), ...lines]);
  }

  // Every file is read before any is written, so a malformed block stops the command before it edits anything.
  const files: { readonly absolute: string; readonly wanted: number[] | 'all'; readonly source: SourceFile; readonly blocks: CompiledBlock[] }[] = [];
  for (const [absolute, wanted] of byFile) {
    const source = new SourceFile(path.relative(cwd, absolute), await readFile(absolute, 'utf8'));
    try {
      files.push({ absolute, wanted, source, blocks: source.compiledBlocks() });
    } catch (cause) {
      return fail(`${errorMessage(cause)}; nothing was reverted`);
    }
  }

  let reverted = 0;
  for (const { absolute, wanted, source, blocks } of files) {
    const relative = path.relative(cwd, absolute);
    let chosen = blocks;
    if (wanted !== 'all') {
      const picked = new Set<CompiledBlock>();
      for (const line of wanted) {
        const inside = blocks.filter((block) => line >= block.line && line <= source.lineOf(block.end));
        const test = inside.length > 0 ? undefined : source.testAt(line);
        for (const block of inside) picked.add(block);
        if (test !== undefined) for (const block of blocks) if (block.start > test.bodyStart && block.end < test.bodyEnd) picked.add(block);
      }
      // A call keeps counting its repeats: reverting one block of a step's repeats would hand another its recording.
      const named = Array.from(picked);
      for (const block of named) {
        const test = source.testContaining(block.start);
        if (test === undefined || block.step === undefined) continue;
        for (const other of blocks) if (other.step === block.step && other.start > test.bodyStart && other.end < test.bodyEnd) picked.add(other);
      }
      chosen = blocks.filter((block) => picked.has(block));
    }
    if (chosen.length === 0) {
      process.stdout.write(`${relative}: no compiled block${wanted === 'all' ? '' : ` at ${wanted.join(', ')}`}\n`);
      continue;
    }
    reverted += chosen.length;
    await emit(cwd, relative, source.text, applyEdits(source.text, chosen.map((block) => ({ start: block.start, end: block.end, text: block.from }))), options.write === true);
  }
  const verb = options.write === true ? 'reverted' : 'would revert';
  process.stdout.write(`\n${picocolors.bold(`${String(reverted)} block(s) ${verb}`)}${options.write === true || reverted === 0 ? '' : '; pass --write to change the files'}\n`);
  return 0;
}

/** Prints an error line and returns the config-error exit code. */
function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

function skipMark(): string {
  return picocolors.yellow('–');
}

function codeLabel(code: string): string {
  return picocolors.cyan(`[${code}]`);
}

function siteLabel(site: ActSite): string {
  return `${picocolors.dim(`L${String(site.line)}`)} ${JSON.stringify(site.instruction ?? site.source)}`;
}

/** Writes a file's new text, or prints the change. */
async function emit(root: string, file: string, before: string, after: string, write: boolean): Promise<void> {
  if (write) await writeFile(path.resolve(root, file), after);
  else process.stdout.write(`\n${picocolors.bold(file)}\n${diff(before, after)}\n`);
}

/** `file:line` of a test's declaration, as `e2e run` selects it. */
function declaration(test: CollectedTest): string {
  return `${test.file}:${String(test.source?.line ?? 1)}`;
}

/**
 * Every readable recording for the target, newest per step, by the test id
 * it was recorded for. A step is what `cache.strict` names one by
 * (`cache/rekeyed.ts`): the test, the target, the instruction and params
 * digests, the occurrence, and the agent. Truncated recordings stay, so
 * their step reports `truncated` rather than looking unrecorded.
 */
async function readRecordings(config: ResolvedConfig, target: string): Promise<ReadonlyMap<string, readonly Recording[]>> {
  const store = new FileCacheStore({ directory: config.cache.dir, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
  const project = projectIdentity(config.projectId);
  const newest = new Map<string, Recording>();
  for (const keyHash of await store.keyHashes()) {
    const read = await store.read(keyHash);
    if (read.status !== 'hit') continue;
    const trace = read.entry.payload;
    const recordedFor = trace.recordedFor;
    if (recordedFor === undefined || recordedFor.targetId !== target) continue;
    // A recording under another schema, replay policy, or project is one a run no longer replays.
    const keyedBy = trace.keyedBy;
    if (keyedBy !== undefined && (keyedBy.cacheSchema !== TRACE_SCHEMA_VERSION || keyedBy.policyVersion !== REPLAY_POLICY_VERSION || keyedBy.project !== project)) continue;
    const { testId, targetId, instructionDigest, paramsDigest: params, callIndex, agent } = recordedFor;
    const step = JSON.stringify([testId, targetId, instructionDigest, params ?? null, callIndex ?? null, agent ?? null]);
    const seen = newest.get(step);
    if (seen === undefined || seen.createdAt < read.entry.createdAt) newest.set(step, { keyHash, createdAt: read.entry.createdAt, trace });
  }
  const byTest = new Map<string, Recording[]>();
  for (const recording of newest.values()) {
    const id = recording.trace.recordedFor!.testId;
    (byTest.get(id) ?? byTest.set(id, []).get(id)!).push(recording);
  }
  return byTest;
}

/** Each selected test's source, compiled blocks, and what becomes of each of its `agent.act()` calls. */
async function planAll(project: Project, tests: readonly CollectedTest[], recordings: ReadonlyMap<string, readonly Recording[]>): Promise<TestPlan[]> {
  const { projectRoot } = project.config;
  const declaredAt = new Map<string, number>();
  for (const test of tests) declaredAt.set(declaration(test), (declaredAt.get(declaration(test)) ?? 0) + 1);
  // The recorder bounds a test id it keeps; a long one is matched as it was kept, unless another test's bounds alike.
  const keptIds = new Map<string, number>();
  for (const test of tests) keptIds.set(bound(test.id, MAX_TRACE_DESCRIPTOR_CHARS), (keptIds.get(bound(test.id, MAX_TRACE_DESCRIPTOR_CHARS)) ?? 0) + 1);
  const plans: TestPlan[] = [];
  for (const test of tests) {
    const keptId = bound(test.id, MAX_TRACE_DESCRIPTOR_CHARS);
    const mine = recordings.get(keptId) ?? [];
    const none = { test, testSource: undefined, outcomes: [], blocks: [], recordings: mine };
    if ((keptIds.get(keptId) ?? 0) > 1) {
      plans.push({ ...none, placement: { code: 'ambiguous-recording', reason: `another test's id shares its first ${String(MAX_TRACE_DESCRIPTOR_CHARS)} characters, which is all a recording keeps of it` } });
      continue;
    }
    if (test.source === undefined || path.resolve(projectRoot, test.source.file) !== path.resolve(projectRoot, test.file)) {
      if (mine.length > 0) plans.push({ ...none, placement: { code: 'not-in-body', reason: 'the test is declared in another file than its own' } });
      continue;
    }
    const source = await project.sourceOf(test.file);
    const testSource = source.testAt(test.source.line);
    if (testSource === undefined) {
      if (mine.length > 0) plans.push({ ...none, placement: { code: 'not-in-body', reason: 'its declaration is not a call with a callback at that line' } });
      continue;
    }
    let blocks: readonly CompiledBlock[] = [];
    try {
      blocks = source.compiledBlocks().filter((block) => block.start > testSource.bodyStart && block.end < testSource.bodyEnd);
    } catch {
      blocks = [];
    }
    const base = { test, testSource, blocks, recordings: mine };
    if ((declaredAt.get(declaration(test)) ?? 0) > 1) {
      plans.push({ ...base, outcomes: [], placement: { code: 'loop-declared', reason: 'several tests are declared at this line (a loop), so the source is not one test\'s' } });
      continue;
    }
    if (testSource.sites.length === 0) {
      if (mine.length > 0 && blocks.length === 0) plans.push({ ...base, outcomes: [], placement: { code: 'not-in-body', reason: 'no agent.act() in the test body itself (a helper it calls is not compiled)' } });
      else if (blocks.length > 0) plans.push({ ...base, outcomes: [] });
      continue;
    }
    plans.push({ ...base, outcomes: planTest(testSource, mine, project.context) });
  }
  return plans;
}

/** A call's signature as the cache keys it, or undefined when its params are not spelled out in the source. */
function signatureOf(site: ActSite, context: PlanContext): string | undefined {
  if (site.digest === undefined || site.params === undefined) return undefined;
  const digest = digestParams(site.params, context);
  return digest === undefined ? undefined : `${site.digest}.${digest}`;
}

/** Pins each call of one test to its recording, or says why it cannot be. */
function planTest(testSource: TestSource, recordings: readonly Recording[], context: PlanContext): Outcome[] {
  const { sites } = testSource;
  if (sites.some((site) => site.digest === undefined)) {
    return sites.map((site) => ({
      kind: 'skipped',
      site,
      code: 'dynamic-instruction',
      reason: site.digest === undefined ? 'the instruction is built at run time' : 'another call in this test builds its instruction at run time and could share this one\'s recordings',
      unverified: [],
    }));
  }
  const agents = new Set(recordings.map((recording) => recording.trace.recordedFor?.agent));
  if (agents.size > 1) {
    return sites.map((site) => ({ kind: 'skipped', site, code: 'ambiguous-recording', reason: `the test was recorded for several agents (${[...agents].join(', ')}), and one compiled body cannot serve them all`, unverified: [] }));
  }
  const signatures = new Map(sites.map((site) => [site, signatureOf(site, context)]));
  // Calls of one step, as the cache counts their repeats; without a signature, the instruction is all there is.
  const stepOf = (site: ActSite): string => signatures.get(site) ?? `instruction:${site.digest!}`;
  const byInstruction = new Map<string, ActSite[]>();
  for (const site of sites) (byInstruction.get(site.digest!) ?? byInstruction.set(site.digest!, []).get(site.digest!)!).push(site);

  const outcomes = new Map<ActSite, Outcome>();
  for (const [digest, group] of byInstruction) {
    const forInstruction = recordings.filter((recording) => recording.trace.recordedFor?.instructionDigest === digest);
    const skipAll = (code: Code, reason: string): void => {
      for (const site of group) outcomes.set(site, { kind: 'skipped', site, code, reason, unverified: [] });
    };
    const optioned = group.find((site) => site.droppedOptions.length > 0);
    if (optioned !== undefined) {
      skipAll('step-options', `the call passes ${optioned.droppedOptions.join(', ')}, which compiled lines would drop`);
      continue;
    }
    const nested = group.find((site) => site.nested !== undefined);
    if (nested !== undefined) {
      skipAll('nested-call', group.length === 1 ? nested.nested! : 'a call with this instruction is not a bare statement of the test body, so the repeats cannot be counted from the source');
      continue;
    }
    if (group.some((site) => signatures.get(site) === undefined)) {
      // The cache keys a call by its params; the source does not spell these out, so the recording cannot be checked against them.
      const [site] = group;
      if (!context.loose || group.length > 1 || site === undefined) {
        skipAll(
          'dynamic-params',
          group.length > 1
            ? 'calls with this instruction pass params the source does not spell out, so their recordings cannot be told apart'
            : 'the params are not literals the source spells out, so the recording cannot be checked against them (--loose takes the only recording)',
        );
        continue;
      }
      if (forInstruction.length === 0) outcomes.set(site, { kind: 'missing', site });
      else if (forInstruction.length > 1) skipAll('ambiguous-recording', `${String(forInstruction.length)} recordings with this instruction, and params the source does not spell out`);
      else outcomes.set(site, compileOutcome(site, forInstruction[0]!, context));
      continue;
    }
    const bySignature = new Map<string, ActSite[]>();
    for (const site of group) {
      const signature = signatures.get(site)!;
      (bySignature.get(signature) ?? bySignature.set(signature, []).get(signature)!).push(site);
    }
    for (const [signature, twins] of bySignature) {
      const params = signature.slice(signature.indexOf('.') + 1);
      const entries = forInstruction.filter((recording) => recording.trace.recordedFor?.paramsDigest === params);
      // The cache counts repeats across the attempt, helpers included: more recordings than calls here, or one out of
      // range, means another call shares the count, and which recording is whose cannot be told from this body.
      const beyond = entries.filter((recording) => (recording.trace.recordedFor?.callIndex ?? twins.length) >= twins.length);
      if (entries.length > twins.length || beyond.length > 0) {
        for (const site of twins) {
          outcomes.set(site, { kind: 'skipped', site, code: 'ambiguous-recording', reason: `${String(entries.length)} recording(s) of this step for ${String(twins.length)} call(s) in the test body; a helper or an older version of the test shares its count`, unverified: [] });
        }
        continue;
      }
      for (const [index, site] of twins.entries()) {
        const match = entries.find((recording) => recording.trace.recordedFor?.callIndex === index);
        outcomes.set(site, match === undefined ? { kind: 'missing', site } : compileOutcome(site, match, context));
      }
    }
  }
  // A call left to the agent keeps counting its repeats, so a step's calls compile whole or not at
  // all: compiling one repeat away would hand the next one the recording of the call before it.
  return sites.map((site) => {
    const outcome = outcomes.get(site)!;
    if (outcome.kind !== 'compiled') return outcome;
    const whole = sites.filter((twin) => stepOf(twin) === stepOf(site)).every((twin) => outcomes.get(twin)?.kind === 'compiled');
    return whole
      ? outcome
      : { kind: 'skipped', site, code: 'group-partial', reason: 'another call of this step stays with the agent, and compiling this one would shift its recording', unverified: [] };
  });
}

/** The outcome a recording gives its call. */
function compileOutcome(site: ActSite, recording: Recording, context: PlanContext): Outcome {
  const result: CompileResult = compileTrace(recording.trace, { ...context, uniques: site.uniques });
  return result.ok
    ? { kind: 'compiled', site, step: result.step, recording, unverified: result.unverified }
    : { kind: 'skipped', site, code: result.code, reason: result.reason, unverified: result.unverified };
}

/**
 * Runs each compiled test once, with no retries, and puts back every block of
 * a test that did not pass: a compiled step stays only when its lines passed
 * on the live app. Returns how many blocks went back.
 */
async function verifyCompiled(project: Project, written: readonly { readonly test: CollectedTest; readonly recordings: ReadonlySet<string> }[], options: CompileOptions): Promise<number> {
  const { config } = project;
  const positionals = [...new Set(written.map(({ test }) => declaration(test)))];
  process.stdout.write(`\n${picocolors.bold('Verifying')} ${String(written.length)} compiled test(s): e2e run ${positionals.join(' ')}\n\n`);
  const reportPath = path.join(config.output, 'report.json');
  await rm(reportPath, { force: true });
  // Line numbers moved with the edits, so the files and titles select the tests. Every target runs:
  // a test on several targets keeps its compiled lines only when they pass on each.
  await runTests(config, undefined, [...new Set(written.map(({ test }) => test.file))], options, ['--retries=0', `--grep=${written.map(({ test }) => `^${escapeRegExp(test.titlePath.join(' '))}$`).join('|')}`]);
  const statuses = new Map<string, string>();
  try {
    const report = ReportResults.parse(JSON.parse(await readFile(reportPath, 'utf8')));
    // A target that skipped the test says nothing; one that did not pass decides, and one must pass.
    for (const result of report.run.results) {
      if (result.status === 'skipped') continue;
      if (statuses.get(result.testId) === undefined || result.status !== 'passed') statuses.set(result.testId, result.status);
    }
  } catch {
    // No report: no test is known to have passed, so every block goes back.
  }
  let reverted = 0;
  process.stdout.write('\n');
  for (const { test, recordings } of written) {
    const status = statuses.get(test.id);
    const absolute = path.join(config.projectRoot, test.file);
    const source = new SourceFile(test.file, await readFile(absolute, 'utf8'));
    let blocks: readonly CompiledBlock[];
    try {
      blocks = source.compiledBlocks().filter((block) => block.recording !== undefined && recordings.has(block.recording));
    } catch (cause) {
      process.stdout.write(`${skipMark()} ${test.titlePath.join(' › ')} ${codeLabel('verify-failed')} ${errorMessage(cause)}; the file is left as compiled\n`);
      continue;
    }
    if (status === 'passed') {
      // A run passed on these lines: they are no longer a guess, and the block says when that was shown.
      await writeFile(absolute, applyEdits(source.text, blocks.map((block) => ({ start: block.start, end: block.end, text: verifiedBlock(source.text.slice(block.start, block.end), today()) }))));
      process.stdout.write(`${picocolors.green('✓')} ${test.titlePath.join(' › ')} passed with its compiled lines\n`);
      continue;
    }
    await writeFile(absolute, applyEdits(source.text, blocks.map((block) => ({ start: block.start, end: block.end, text: block.from }))));
    reverted += blocks.length;
    process.stdout.write(`${skipMark()} ${test.titlePath.join(' › ')} ${codeLabel('verify-failed')} the test ${status === undefined ? 'did not run' : status} with its compiled lines; ${String(blocks.length)} block(s) are agent.act() again\n`);
  }
  return reverted;
}

/** What `--verify` reads of the run's `report.json`: each result's test id and status. */
const ReportResults = z.looseObject({ run: z.looseObject({ results: z.array(z.looseObject({ testId: z.string(), status: z.string() })) }) });

/** A compiled block's text once a run passed on it: an `@verifiedAt` tag, and no line still marked a guess. */
function verifiedBlock(text: string, date: string): string {
  const tagged = text.replace(/(\r?\n)([ \t]*) \*\/(\r?\n)/u, `$1$2 * @verifiedAt ${date}$1$2 */$3`);
  return tagged.replaceAll(' // unverified locator;', ' //').replaceAll(' // unverified locator', '');
}

/** Today's date as the tags spell it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Text matched as itself in a regular expression. */
function escapeRegExp(text: string): string {
  return [...text].map((ch) => escapeRegexpChar(ch)).join('');
}

/**
 * Runs tests through this e2e's own CLI, as `run_tests` does, so they record
 * the way any run does. A run that cannot start is an error, not a run whose
 * tests all failed.
 */
async function runTests(config: ResolvedConfig, target: string | undefined, files: readonly string[], options: CompileOptions, extra: readonly string[] = []): Promise<void> {
  const entry = cliEntry();
  const flags = [
    ...(target === undefined ? [] : [`--target=${target}`]),
    '--reporter=list',
    ...(config.configPath === undefined ? [] : [`--config=${config.configPath}`]),
    ...(options.cacheDir === undefined ? [] : [`--cache-dir=${options.cacheDir}`]),
    ...extra,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...entry.execArgv, entry.path, 'run', ...flags, '--', ...files], { cwd: config.projectRoot, stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', reject);
  });
}

/** The source with every edit applied, last first so offsets stay valid. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  return out;
}

/** A minimal line diff: the changed region of each run of differing lines, with a line of context. */
function diff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const rows: { readonly mark: ' ' | '-' | '+'; readonly text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ mark: ' ', text: a[i++]! });
      j += 1;
    } else if (j < b.length && (i >= a.length || table[i]![j + 1]! > table[i + 1]![j]!)) rows.push({ mark: '+', text: b[j++]! });
    else rows.push({ mark: '-', text: a[i++]! });
  }
  const keep = rows.map((row, index) => row.mark !== ' ' || rows[index - 1]?.mark === '-' || rows[index - 1]?.mark === '+' || rows[index + 1]?.mark === '-' || rows[index + 1]?.mark === '+');
  const out: string[] = [];
  rows.forEach((row, index) => {
    if (!keep[index]) {
      if (keep[index - 1] === true) out.push(picocolors.dim('  ...'));
      return;
    }
    const line = `${row.mark} ${row.text}`;
    out.push(row.mark === '-' ? picocolors.red(line) : row.mark === '+' ? picocolors.green(line) : picocolors.dim(line));
  });
  return out.join('\n');
}
