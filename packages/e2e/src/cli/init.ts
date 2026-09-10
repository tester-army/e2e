/** Non-destructive project scaffolding. */

import * as clack from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPackageManager, execCommand, runScriptCommand } from '../internal/package-manager.ts';
import { DOCS_URL } from './docs-url.ts';
import { findInstalledSkillDirs, planSkillInstall, SKILL_LOCATIONS } from './init/agent-skill.ts';
import { isLoopbackHost } from '../internal/urls.ts';
import { getEnginePresets, DEFAULT_ENGINE_ID, type EngineId } from './init/engines.ts';
import { GATEWAYS, type GatewayId } from './init/gateways.ts';
import { addDependencies, addScripts, describeManifestError, readPackage, serializePackage } from './init/package.ts';
import { createScaffold, type ScaffoldModel } from './init/scaffold.ts';
import { MISSING_SKILL_MESSAGE, readSkillFiles } from './skill.ts';

export interface InitOptions {
  yes?: boolean;
  /**
   * The directory argument as the user typed it, when `cwd` was chosen from
   * one; the closing `next:` line then starts with `cd` into it.
   */
  directory?: string;
  /**
   * Whether prompts can be answered. The CLI passes its terminal state; a
   * non-interactive run without `--yes` stops before asking anything, since
   * a prompt nobody can answer would otherwise wait forever.
   */
  interactive?: boolean;
}

const CACHE_IGNORE_ENTRY = '.e2e/cache/';

const GITIGNORE_ENTRIES = [
  'node_modules/',
  '.e2e/artifacts/',
  CACHE_IGNORE_ENTRY,
  '.e2e/sessions/',
  '.e2e/report.json',
  '.e2e/ai-trace.json',
  '.e2e/junit.xml',
  '.e2e/logs/',
];

const RUN_SCRIPT = 'test:e2e';
const SCRIPTS = { [RUN_SCRIPT]: 'e2e run' };

/** The gateway `--yes` picks; the choice is written into the config either way. */
const DEFAULT_GATEWAY: GatewayId = 'vercel';

type GatewayChoice = GatewayId | 'none';

/**
 * Runs `e2e init`. Every prompt happens before the first write, existing
 * config and test files are never touched, and dependencies install only when
 * the user asks. The agent skill is offered once; later runs refresh the
 * copies that exist and never add new locations.
 */
export async function init(cwd: string, options: InitOptions = {}): Promise<number> {
  clack.intro(options.directory === undefined ? 'e2e init' : `e2e init ${options.directory}`);

  if (options.interactive === false && !options.yes) {
    clack.log.error(
      'e2e init asks questions and needs an interactive terminal; run it from a terminal, or pass --yes to accept the defaults (Playwright, the Vercel AI Gateway, no installation)',
    );
    return 2;
  }
  if (existsSync(cwd) && !statSync(cwd).isDirectory()) {
    clack.log.error(`${options.directory ?? cwd} is a file, not a directory`);
    return 2;
  }

  let pkg: ReturnType<typeof readPackage>;
  try {
    pkg = readPackage(cwd);
  } catch (cause) {
    clack.log.error(`${path.join(cwd, 'package.json')} could not be read: ${describeManifestError(cause)}; fix it before running e2e init`);
    return 2;
  }
  const bundledSkill = readSkillFiles();
  if (bundledSkill.length === 0) {
    clack.log.error(MISSING_SKILL_MESSAGE);
    return 2;
  }

  const existingConfig = ['e2e.config.ts', 'e2e.config.mts'].find((file) => existsSync(path.join(cwd, file)));
  const examplePath = path.join('tests', 'example.e2e.ts');
  const exampleExists = existsSync(path.join(cwd, examplePath));
  if (existingConfig !== undefined) clack.log.warn(`exists, not touching: ${existingConfig}`);
  if (exampleExists) clack.log.warn(`exists, not touching: ${examplePath}`);

  const gitignorePath = path.join(cwd, '.gitignore');
  const existingIgnore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const ignoreLines = existingIgnore.split(/\r?\n/);
  const missingIgnore = GITIGNORE_ENTRIES.filter((entry) => !ignoreLines.includes(entry));

  // Engine and model gateway are choices for a new config only; an existing config keeps its own dependencies.
  let engine: EngineId = existingConfig === undefined ? DEFAULT_ENGINE_ID : 'none';
  let model: ScaffoldModel | undefined = existingConfig === undefined ? { gateway: DEFAULT_GATEWAY } : undefined;
  if (existingConfig === undefined && !options.yes) {
    const selectedEngine = await clack.select<EngineId>({
      message: 'Which engine?',
      initialValue: DEFAULT_ENGINE_ID,
      options: getEnginePresets().map(({ id, label, hint }) => ({ value: id, label, hint })),
    });
    if (clack.isCancel(selectedEngine)) return cancelled();
    engine = selectedEngine;

    // The gateway is a visible choice, not a runner default: the config imports
    // its provider package and constructs the model.
    const gateway = await clack.select<GatewayChoice>({
      message: 'Which model gateway for agent steps? Adds AI SDK v7.',
      initialValue: DEFAULT_GATEWAY,
      options: [
        ...GATEWAYS.map(({ id, label, hint }) => ({ value: id, label, hint })),
        { value: 'none', label: 'None', hint: 'deterministic tests only; add a gateway later' },
      ],
    });
    if (clack.isCancel(gateway)) return cancelled();
    if (gateway === 'none') {
      model = undefined;
    } else if (gateway === 'openai-compatible') {
      const endpoint = await clack.text({
        message: 'Base URL of the OpenAI-compatible API',
        placeholder: 'http://127.0.0.1:11434/v1',
        validate: validateEndpoint,
      });
      if (clack.isCancel(endpoint)) return cancelled();
      model = { gateway, endpoint: endpoint.trim() };
    } else {
      model = { gateway };
    }
  }

  // The skill goes where an earlier run put it; a project without one chooses.
  let skillDirs: readonly string[] = findInstalledSkillDirs(cwd);
  if (skillDirs.length === 0) {
    if (options.yes) {
      skillDirs = SKILL_LOCATIONS.map((location) => location.dir);
    } else {
      const selected = await clack.multiselect<string>({
        message: 'Install the e2e skill for coding agents?',
        options: SKILL_LOCATIONS.map(({ dir, hint }) => ({ value: dir, label: dir, hint })),
        initialValues: SKILL_LOCATIONS.map((location) => location.dir),
        required: false,
      });
      if (clack.isCancel(selected)) return cancelled();
      skillDirs = selected;
    }
  }
  const skillInstalls = planSkillInstall(cwd, skillDirs, bundledSkill);

  const scaffold = createScaffold(engine, model);
  const dependencies = addDependencies(pkg.manifest, scaffold.dependencies);
  const { manifest, additions: scripts } = addScripts(dependencies.manifest, SCRIPTS);
  if (dependencies.additions.length > 0) {
    clack.log.info(`add dev dependencies: ${dependencies.additions.map(([name, version]) => `${name}@${version}`).join(', ')}`);
  }
  if (scripts.length > 0) {
    clack.log.info(`add scripts: ${scripts.map(([name, command]) => `${name} (${command})`).join(', ')}`);
  }

  const files = [
    ...(pkg.original === undefined || dependencies.additions.length > 0 || scripts.length > 0
      ? [{ relative: 'package.json', content: serializePackage(manifest, pkg.original), existing: pkg.original !== undefined }]
      : []),
    ...(existingConfig === undefined ? [{ relative: 'e2e.config.ts', content: scaffold.config, existing: false }] : []),
    ...(exampleExists ? [] : [{ relative: examplePath, content: scaffold.example, existing: false }]),
  ];

  if (files.length === 0 && skillInstalls.length === 0 && missingIgnore.length === 0) {
    clack.outro('nothing to create; project already initialized');
    return 0;
  }

  if (!options.yes) {
    const actions = [
      ...files.map((file) => `${file.existing ? 'update' : 'create'} ${file.relative}`),
      ...skillInstalls.map((install) => `${install.existing ? 'update' : 'create'} ${install.relative}/`),
      ...(missingIgnore.length > 0 ? ['update .gitignore'] : []),
    ];
    const proceed = await clack.confirm({ message: `${actions.join(', ')}?` });
    if (clack.isCancel(proceed) || !proceed) return cancelled();
  }

  const manager = detectPackageManager(cwd, manifest.packageManager);
  let install = false;
  if (!options.yes) {
    const selected = await clack.confirm({ message: `Install dependencies with ${manager}?`, initialValue: true });
    if (clack.isCancel(selected)) return cancelled();
    install = selected;
  }

  // The first write; a directory named on the command line comes into being here.
  mkdirSync(cwd, { recursive: true });
  for (const file of files) {
    const absolute = path.join(cwd, file.relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, 'utf8');
    clack.log.success(`${file.existing ? 'updated' : 'created'} ${file.relative}`);
  }
  for (const skill of skillInstalls) {
    for (const file of skill.files) {
      mkdirSync(path.dirname(file.absolute), { recursive: true });
      writeFileSync(file.absolute, file.content, 'utf8');
    }
    clack.log.success(`${skill.existing ? 'updated' : 'created'} ${skill.relative}/ (${skill.files.length} files)`);
  }
  if (skillDirs.length === 0) {
    clack.log.info(`skipped the agent skill; agents can still print it with ${execCommand(manager, 'e2e guide')}`);
  }
  if (missingIgnore.length > 0) {
    const prefix = existingIgnore === '' || existingIgnore.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignorePath, `${existingIgnore}${prefix}${missingIgnore.join('\n')}\n`, 'utf8');
    clack.log.success(`updated .gitignore (${missingIgnore.length} entries)`);
    if (missingIgnore.includes(CACHE_IGNORE_ENTRY)) {
      clack.log.info(`${CACHE_IGNORE_ENTRY} is ignored; committing agent.act replays is opt-in, see ${DOCS_URL}/reference/config#commit-your-traces`);
    }
  }

  if (install) {
    const result = spawnSync(manager, ['install'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error !== undefined || result.status !== 0) {
      const reason = result.error?.message ?? `exit ${result.status ?? result.signal}`;
      clack.log.error(`installation failed (${reason}); retry with ${manager} install`);
      clack.outro('scaffold saved');
      return result.signal === 'SIGINT' ? 130 : 2;
    }
  }
  if (!existsSync(path.join(cwd, 'tsconfig.json'))) {
    clack.log.info('no tsconfig.json; add one for editor completions on e2e.config.ts and tests/');
  }
  // The script init adds, unless the project already had one of its own under that name.
  const runCommand = manifest.scripts?.[RUN_SCRIPT]?.startsWith('e2e run')
    ? runScriptCommand(manager, RUN_SCRIPT)
    : execCommand(manager, 'e2e run');
  const next = [
    options.directory === undefined ? undefined : `cd ${shellArgument(options.directory)}`,
    install ? undefined : `${manager} install`,
    `${scaffold.needsAppUrl ? 'APP_URL=http://localhost:3000 ' : ''}${runCommand}`,
  ].filter((step) => step !== undefined);
  clack.outro(`next: ${next.join(', then ')}`);
  return 0;
}

/**
 * A path as the user will paste it into their shell: bare while every character
 * is safe, otherwise quoted for the platform (single quotes for POSIX shells,
 * double quotes for cmd and PowerShell), so `apps/my web` stays one argument.
 */
function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./@%+=:,-]+$/.test(value)) return value;
  return os.platform() === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The same rule config resolution applies: HTTPS, or HTTP on a loopback host. */
function validateEndpoint(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return 'enter the base URL, e.g. http://127.0.0.1:11434/v1';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `not a URL: ${trimmed}`;
  }
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) return undefined;
  return 'must use HTTPS unless the host is loopback';
}

/** Cancellation is only reachable before the first write, so nothing needs undoing. */
function cancelled(): number {
  clack.cancel('cancelled; no changes were made');
  return 0;
}
