/**
 * The `e2e-cige` command: what an agent (or a person) runs between CIGE
 * runs. `replay` reruns one case in its environment after a repair, `env`
 * provisions, resets, or tears an environment down without touching any
 * case, `refs` fetches the spec, release notes, and expected output a
 * classifier compares a failure with, `check` lists what each case lacks
 * for that before anything fails, and `diff` checks a change against the
 * field rules. It reads `cige.config.ts` from the working directory.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { readinessGaps, type CigeGap } from './check.ts';
import { DEFAULT_CASES, type CigeConfig } from './config.ts';
import { diffSince, formatDiff } from './diff.ts';
import { loadCigeCases } from './load.ts';
import { writeRefs } from './refs.ts';
import type { CigeCase } from './schema.ts';
import { cigeTag } from './suite.ts';
import { caseForVariant } from './variants.ts';

const USAGE = `Usage: npx e2e-cige <command> [options]

Commands:
  replay <id> [--variant <v>] [--env <name>] [-- <e2e run options>]
      Reset the case's environment, then run the case alone with the replay
      cache off: e2e run [--config <env config>] --tag cige:<id> --no-cache.
  env <provision|reset|teardown> <name>
      Run one action of an environment the config declares.
  refs <id> [--variant <v>] [--build <build>] [--output <dir>]
      Resolve the case's spec, build, and expected refs into
      <output>/<id>.refs/ (default .e2e/cige).
  check [--resolve] [--warn] [--json]
      List what each case lacks for classification and replay: a spec or
      build ref, the build for {build}, a declared environment with a reset.
      --resolve also runs the ref resolvers. Exits 1 on any gap unless --warn.
  diff [--base <git ref>] [--json] [--allow-intent]
      Check every .cige.json changed since the base (default origin/main)
      against the field rules, and report any change to the CIGE config or
      the local modules it imports. Exits 1 when a change weakens a case or
      touches the config.
      --allow-intent exits 0 anyway and records nothing: pass it only once
      a human approved the change, never from an agent.

Options:
  --config <file>   The CIGE config (default: cige.config.ts, .mts, .js, or .mjs
                    in the working directory)
`;

const CONFIG_FILES = ['cige.config.ts', 'cige.config.mts', 'cige.config.js', 'cige.config.mjs'];

/** What `main` writes to, where it runs, and how it starts `e2e`; tests replace them. */
export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runE2e: (args: readonly string[], cwd: string) => Promise<number>;
}

/** The `e2e` bin a parsed `package.json` declares, when it is the runner's. */
function binOf(pkg: unknown): string | undefined {
  if (typeof pkg !== 'object' || pkg === null || !('name' in pkg) || pkg.name !== 'e2e' || !('bin' in pkg)) return undefined;
  const { bin } = pkg;
  if (typeof bin === 'string') return bin;
  if (typeof bin === 'object' && bin !== null && 'e2e' in bin && typeof bin.e2e === 'string') return bin.e2e;
  return undefined;
}

/** The `e2e` bin the installed runner declares, run with this Node. */
function e2eBin(): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve('e2e')));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      const pkg: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      const bin = binOf(pkg);
      if (bin !== undefined) return path.resolve(dir, bin);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('cannot find the e2e command; install e2e beside @e2e-dev/cige');
    dir = parent;
  }
}

const PROCESS_IO: CliIo = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  runE2e: (args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [e2eBin(), ...args], { cwd, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
    }),
};

class UsageError extends Error {}

interface Loaded {
  readonly config: CigeConfig;
  /** Where the config's relative paths resolve from: its own directory. */
  readonly dir: string;
  readonly file?: string;
}

async function loadConfig(cwd: string, explicit: string | undefined, required: boolean): Promise<Loaded> {
  const file = explicit === undefined ? CONFIG_FILES.map((name) => path.join(cwd, name)).find((candidate) => existsSync(candidate)) : path.resolve(cwd, explicit);
  if (file === undefined || !existsSync(file)) {
    if (required || explicit !== undefined) throw new UsageError(`no CIGE config at ${explicit ?? CONFIG_FILES[0]}; export defineCige({...}) from it`);
    return { config: {}, dir: cwd };
  }
  const module = (await import(pathToFileURL(file).href)) as { default?: CigeConfig };
  if (module.default === undefined || typeof module.default !== 'object') throw new UsageError(`${file} has no default export; export default defineCige({...})`);
  return { config: module.default, dir: path.dirname(file), file };
}

function findCase(loaded: Loaded, id: string, variant: string | undefined): CigeCase {
  const cases = loadCigeCases(loaded.config.cases ?? DEFAULT_CASES, { root: loaded.config.root ?? loaded.dir });
  const testCase = cases.find((candidate) => candidate.id === id);
  if (testCase === undefined) throw new UsageError(`no CIGE case has the id "${id}"; known: ${cases.map((candidate) => candidate.id).join(', ') || 'none'}`);
  const resolved = caseForVariant(testCase, variant);
  if (resolved === undefined) {
    throw new UsageError(
      variant === undefined
        ? `case "${id}" has variants; pass --variant ${testCase.variants.map((entry) => entry.id).join('|')}`
        : `case "${id}" has no variant "${variant}"`,
    );
  }
  return resolved;
}

function environmentOf(config: CigeConfig, name: string): NonNullable<CigeConfig['environments']>[string] {
  const environments = config.environments ?? {};
  if (!Object.hasOwn(environments, name)) {
    throw new UsageError(`the config declares no environment "${name}"; known: ${Object.keys(environments).join(', ') || 'none'}`);
  }
  return environments[name]!;
}

async function replay(io: CliIo, args: readonly string[]): Promise<number> {
  const split = args.indexOf('--');
  const own = split === -1 ? args : args.slice(0, split);
  const passthrough = split === -1 ? [] : args.slice(split + 1);
  const { values, positionals } = parseArgs({
    args: [...own],
    allowPositionals: true,
    options: { variant: { type: 'string' }, env: { type: 'string' }, config: { type: 'string' } },
  });
  const [id] = positionals;
  if (id === undefined || positionals.length > 1) throw new UsageError('replay takes one case id');
  const loaded = await loadConfig(io.cwd, values.config, false);
  const testCase = findCase(loaded, id, values.variant);
  const name = values.env ?? testCase.context.environment;
  // A case's environment is prose until the config declares environments; only a declared one is acted on.
  const environment =
    name === undefined || (values.env === undefined && loaded.config.environments === undefined) ? undefined : environmentOf(loaded.config, name);
  if (environment !== undefined) {
    // A replay on state the last run left behind proves nothing about the repair.
    if (environment.reset === undefined) {
      throw new UsageError(`environment "${name}" has no reset action; declare one (a no-op when the environment keeps no state)`);
    }
    io.stderr(`e2e-cige: resetting ${name}\n`);
    await environment.reset();
  }
  const e2eConfig = environment?.config ?? loaded.config.e2eConfig;
  const e2eArgs = [
    'run',
    ...(e2eConfig === undefined ? [] : ['--config', e2eConfig]),
    '--tag',
    cigeTag(testCase.id, testCase.variant),
    '--no-cache',
    ...passthrough,
  ];
  io.stderr(`e2e-cige: e2e ${e2eArgs.join(' ')}\n`);
  return io.runE2e(e2eArgs, loaded.dir);
}

const ACTIONS = ['provision', 'reset', 'teardown'] as const;

async function env(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { config: { type: 'string' } } });
  const [action, name] = positionals;
  if (action === undefined || name === undefined || positionals.length > 2 || !(ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`env takes an action (${ACTIONS.join('|')}) and an environment name`);
  }
  const loaded = await loadConfig(io.cwd, values.config, true);
  const run = environmentOf(loaded.config, name)[action as (typeof ACTIONS)[number]];
  if (run === undefined) throw new UsageError(`environment "${name}" has no ${action} action`);
  await run();
  io.stdout(`${action} ${name}: done\n`);
  return 0;
}

async function refs(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { variant: { type: 'string' }, build: { type: 'string' }, output: { type: 'string' }, config: { type: 'string' } },
  });
  const [id] = positionals;
  if (id === undefined || positionals.length > 1) throw new UsageError('refs takes one case id');
  const loaded = await loadConfig(io.cwd, values.config, false);
  const testCase = findCase(loaded, id, values.variant);
  const outputDir = path.resolve(loaded.dir, values.output ?? loaded.config.outputDir ?? path.join('.e2e', 'cige'));
  const build = values.build ?? loaded.config.build;
  const { directory, index } = await writeRefs(testCase, {
    outputDir,
    ...(loaded.config.refs === undefined ? {} : { refs: loaded.config.refs }),
    ...(build === undefined ? {} : { build }),
  });
  io.stdout(`${path.relative(io.cwd, directory) || '.'}\n`);
  const failed = Object.entries(index.refs).filter(([, entry]) => entry.error !== undefined);
  for (const [kind, entry] of failed) io.stderr(`e2e-cige: the ${kind} resolver failed: ${entry.error}\n`);
  return failed.length > 0 ? 1 : 0;
}

async function check(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      resolve: { type: 'boolean' },
      warn: { type: 'boolean' },
      json: { type: 'boolean' },
      build: { type: 'string' },
      output: { type: 'string' },
      config: { type: 'string' },
    },
  });
  if (positionals.length > 0) throw new UsageError('check takes no positional arguments');
  const loaded = await loadConfig(io.cwd, values.config, false);
  const build = values.build ?? loaded.config.build;
  const config = { ...loaded.config, build };
  const cases = loadCigeCases(config.cases ?? DEFAULT_CASES, { root: config.root ?? loaded.dir });
  const outputDir = path.resolve(loaded.dir, values.output ?? config.outputDir ?? path.join('.e2e', 'cige'));
  const results: { readonly id: string; readonly file?: string; readonly gaps: readonly CigeGap[] }[] = [];
  for (const testCase of cases) {
    const gaps = readinessGaps(testCase, config);
    if (values.resolve === true && config.refs !== undefined) {
      const { index } = await writeRefs(testCase, { outputDir, refs: config.refs, ...(build === undefined ? {} : { build }) });
      for (const [kind, entry] of Object.entries(index.refs)) {
        if (entry.error !== undefined) gaps.push({ kind: 'resolver-failed', detail: `the ${kind} resolver failed: ${entry.error}` });
      }
    }
    const file = testCase.file === undefined ? undefined : path.relative(io.cwd, testCase.file);
    results.push({ id: testCase.id, ...(file === undefined ? {} : { file }), gaps });
  }
  const withGaps = results.filter((result) => result.gaps.length > 0);
  if (values.json === true) {
    io.stdout(`${JSON.stringify({ cases: results.length, ready: results.length - withGaps.length, results: withGaps }, null, 2)}\n`);
  } else {
    for (const result of withGaps) {
      io.stdout(`${result.file ?? result.id} (${result.id})\n`);
      for (const gap of result.gaps) io.stdout(`  ${gap.kind}${gap.plugin === undefined ? '' : ` (${gap.plugin})`}: ${gap.detail}\n`);
    }
    io.stdout(
      withGaps.length === 0
        ? `All ${results.length} CIGE case${results.length === 1 ? ' is' : 's are'} ready to classify and replay.\n`
        : `${withGaps.length} of ${results.length} CIGE case${results.length === 1 ? '' : 's'} ${withGaps.length === 1 ? 'has' : 'have'} gaps.\n`,
    );
  }
  return withGaps.length > 0 && values.warn !== true ? 1 : 0;
}

function diff(io: CliIo, args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { base: { type: 'string' }, json: { type: 'boolean' }, 'allow-intent': { type: 'boolean' }, config: { type: 'string' } },
  });
  if (positionals.length > 0) throw new UsageError('diff takes no positional arguments');
  // Found, not loaded: diff reads the file and its local imports as text, so a broken config can't hide its own change.
  // Every default name, existing or not: a config deleted on this branch still exists at the merge base.
  const configFiles = values.config === undefined ? CONFIG_FILES.map((name) => path.join(io.cwd, name)) : [path.resolve(io.cwd, values.config)];
  if (values.config !== undefined && !(existsSync(configFiles[0]!) && statSync(configFiles[0]!).isFile())) throw new UsageError(`no CIGE config at ${values.config}; export defineCige({...}) from it`);
  const report = diffSince(values.base ?? 'origin/main', io.cwd, { configFiles });
  io.stdout(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatDiff(report));
  return report.blocking > 0 && values['allow-intent'] !== true ? 1 : 0;
}

/** Runs `e2e-cige` with the arguments after the command name and resolves to the exit code. */
export async function main(args: readonly string[], io: CliIo = PROCESS_IO): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  try {
    if (command === 'replay') return await replay(io, rest);
    if (command === 'env') return await env(io, rest);
    if (command === 'refs') return await refs(io, rest);
    if (command === 'check') return await check(io, rest);
    if (command === 'diff') return diff(io, rest);
    throw new UsageError(`unknown command "${command}"`);
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'))) {
      io.stderr(`e2e-cige: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`e2e-cige: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
