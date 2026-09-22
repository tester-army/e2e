/** Non-destructive project scaffolding. */

import * as clack from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPackageManager, execCommand, runScriptCommand } from '../internal/package-manager.ts';
import { DOCS_URL } from './docs-url.ts';
import {
  describeLinks,
  describeObstacles,
  findInstalledSkillDirs,
  planSkillInstall,
  replaceableLinks,
  SKILL_LOCATIONS,
  type SkillInstall,
} from './init/agent-skill.ts';
import { isLoopbackHost } from '../internal/urls.ts';
import { getEnginePresets, DEFAULT_ENGINE_ID, type EngineId } from './init/engines.ts';
import { GATEWAYS, getGatewayPreset, type GatewayId } from './init/gateways.ts';
import { findRegisteredMcpFiles, MCP_LOCATIONS, planMcpRegistration } from './init/mcp-config.ts';
import { addDependencies, addScripts, describeManifestError, readPackage, serializePackage } from './init/package.ts';
import { createScaffold, type ScaffoldModel } from './init/scaffold.ts';
import { MISSING_SKILL_MESSAGE, readSkillFiles } from './skill.ts';
import type { InitOutcome, InitResult } from '../telemetry/events.ts';

export interface InitOptions {
  yes?: boolean;
  /**
   * The directory argument as the user typed it, when `cwd` was chosen from
   * one; the closing `Next:` line then starts with `cd` into it.
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
  '.e2e/summary.md',
  '.e2e/failures/',
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
 * copies that exist, never add new locations, and never write through a
 * symlink.
 */
export async function init(cwd: string, options: InitOptions = {}): Promise<InitOutcome & { readonly exitCode: number }> {
  clack.intro(options.directory === undefined ? 'e2e init' : `e2e init ${options.directory}`);
  // Filled in as the choices are made; every return hands them back with how the run ended.
  const facts: { -readonly [Key in keyof Omit<InitOutcome, 'result'>]: InitOutcome[Key] } = {
    yes: options.yes === true,
    existingConfig: false,
    engine: null,
    gateway: null,
    skill: false,
    mcp: false,
    install: false,
  };
  const done = (result: InitResult, exitCode: number): InitOutcome & { readonly exitCode: number } => ({
    exitCode,
    result,
    ...facts,
  });
  const cancel = (): InitOutcome & { readonly exitCode: number } => done('cancelled', cancelled());

  if (options.interactive === false && !options.yes) {
    clack.log.error(
      'e2e init asks questions and needs an interactive terminal; run it from a terminal, or pass --yes to accept the defaults (Playwright, the Vercel AI Gateway, no installation)',
    );
    return done('not-interactive', 2);
  }
  if (existsSync(cwd) && !statSync(cwd).isDirectory()) {
    clack.log.error(`${options.directory ?? cwd} is a file, not a directory`);
    return done('invalid-project', 2);
  }

  let pkg: ReturnType<typeof readPackage>;
  try {
    pkg = readPackage(cwd);
  } catch (cause) {
    clack.log.error(`${path.join(cwd, 'package.json')} could not be read: ${describeManifestError(cause)}; fix it before running e2e init`);
    return done('invalid-project', 2);
  }
  const bundledSkill = readSkillFiles();
  if (bundledSkill.length === 0) {
    clack.log.error(MISSING_SKILL_MESSAGE);
    return done('invalid-project', 2);
  }

  const existingConfig = ['e2e.config.ts', 'e2e.config.mts'].find((file) => existsSync(path.join(cwd, file)));
  const examplePath = path.join('tests', 'example.e2e.ts');
  const exampleExists = existsSync(path.join(cwd, examplePath));
  facts.existingConfig = existingConfig !== undefined;
  if (existingConfig !== undefined) clack.log.warn(`Exists, not touching: ${existingConfig}`);
  if (exampleExists) clack.log.warn(`Exists, not touching: ${examplePath}`);

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
    if (isCancelled(selectedEngine)) return cancel();
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
    if (isCancelled(gateway)) return cancel();
    if (gateway === 'none') {
      model = undefined;
    } else if (gateway === 'openai-compatible') {
      const endpoint = await clack.text({
        message: 'Base URL of the OpenAI-compatible API',
        placeholder: 'http://127.0.0.1:11434/v1',
        validate: validateEndpoint,
      });
      if (isCancelled(endpoint)) return cancel();
      model = { gateway, endpoint: endpoint.trim() };
    } else {
      model = { gateway };
    }
  }
  if (existingConfig === undefined) {
    facts.engine = engine;
    facts.gateway = model?.gateway ?? 'none';
  }

  const skillDirs = await chooseLocations(
    findInstalledSkillDirs(cwd),
    SKILL_LOCATIONS.map(({ dir, hint }) => ({ value: dir, hint })),
    'Install the e2e skill for coding agents?',
    options.yes,
  );
  if (isCancelled(skillDirs)) return cancel();
  facts.skill = skillDirs.length > 0;
  const skillInstalls: SkillInstall[] = [];
  for (const planned of planSkillInstall(cwd, skillDirs, bundledSkill)) {
    if (planned.obstacles.length > 0) {
      clack.log.warn(`Broken, not touching: ${describeObstacles(planned)}`);
      continue;
    }
    if (planned.links.length === 0) {
      skillInstalls.push(planned);
      continue;
    }
    if (options.yes || !replaceableLinks(planned)) {
      clack.log.warn(`Symlink, not touching: ${describeLinks(planned)}`);
      continue;
    }
    const replace = await clack.confirm({
      message: `Replace the symlink ${describeLinks(planned)} with a copy of the skill?`,
      initialValue: false,
    });
    if (isCancelled(replace)) return cancel();
    if (replace) skillInstalls.push(planned);
  }

  const mcpFiles = await chooseLocations(
    findRegisteredMcpFiles(cwd),
    MCP_LOCATIONS.map(({ file, hint }) => ({ value: file, hint })),
    'Register the e2e MCP server for coding agents?',
    options.yes,
  );
  if (isCancelled(mcpFiles)) return cancel();
  facts.mcp = mcpFiles.length > 0;
  let mcpRegistrations: ReturnType<typeof planMcpRegistration>;
  try {
    mcpRegistrations = planMcpRegistration(cwd, mcpFiles);
  } catch (cause) {
    clack.log.error(cause instanceof Error ? cause.message : String(cause));
    return done('invalid-project', 2);
  }

  const scaffold = createScaffold(engine, model);
  const dependencies = addDependencies(pkg.manifest, scaffold.dependencies);
  const { manifest, additions: scripts } = addScripts(dependencies.manifest, SCRIPTS);
  if (dependencies.additions.length > 0) {
    clack.log.info(`Add dev dependencies: ${dependencies.additions.map(([name, version]) => `${name}@${version}`).join(', ')}`);
  }
  if (scripts.length > 0) {
    clack.log.info(`Add scripts: ${scripts.map(([name, command]) => `${name} (${command})`).join(', ')}`);
  }

  const files = [
    ...(pkg.original === undefined || dependencies.additions.length > 0 || scripts.length > 0
      ? [{ relative: 'package.json', content: serializePackage(manifest, pkg.original), existing: pkg.original !== undefined }]
      : []),
    ...(existingConfig === undefined ? [{ relative: 'e2e.config.ts', content: scaffold.config, existing: false }] : []),
    ...(exampleExists ? [] : [{ relative: examplePath, content: scaffold.example, existing: false }]),
  ];

  if (files.length === 0 && skillInstalls.length === 0 && mcpRegistrations.length === 0 && missingIgnore.length === 0) {
    clack.outro('Nothing to create; project already initialized');
    return done('already-initialized', 0);
  }

  if (!options.yes) {
    const actions = [
      ...files.map((file) => `${file.existing ? 'update' : 'create'} ${file.relative}`),
      ...skillInstalls.map((install) => `${install.links.length > 0 ? 'replace' : install.existing ? 'update' : 'create'} ${install.relative}/`),
      ...mcpRegistrations.map((registration) => `${registration.existing ? 'update' : 'create'} ${registration.relative}`),
      ...(missingIgnore.length > 0 ? ['update .gitignore'] : []),
    ];
    const message = actions.join(', ');
    const proceed = await clack.confirm({ message: `${message.charAt(0).toUpperCase()}${message.slice(1)}?` });
    if (isCancelled(proceed) || !proceed) return cancel();
  }

  const manager = detectPackageManager(cwd, manifest.packageManager);
  let install = false;
  if (!options.yes) {
    const selected = await clack.confirm({ message: `Install dependencies with ${manager}?`, initialValue: true });
    if (isCancelled(selected)) return cancel();
    install = selected;
  }
  facts.install = install;

  // The first write; a directory named on the command line comes into being here.
  mkdirSync(cwd, { recursive: true });
  for (const file of files) {
    const absolute = path.join(cwd, file.relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, 'utf8');
    clack.log.success(`${file.existing ? 'Updated' : 'Created'} ${file.relative}`);
  }
  for (const skill of skillInstalls) {
    for (const link of skill.links) unlinkSync(path.join(cwd, link.relative));
    for (const file of skill.files) {
      mkdirSync(path.dirname(file.absolute), { recursive: true });
      writeFileSync(file.absolute, file.content, 'utf8');
    }
    const verb = skill.links.length > 0 ? 'Replaced' : skill.existing ? 'Updated' : 'Created';
    clack.log.success(`${verb} ${skill.relative}/ (${skill.files.length} files)`);
  }
  if (skillDirs.length === 0) {
    clack.log.info(`Skipped the agent skill; agents can still print it with ${execCommand(manager, 'e2e guide')}`);
  }
  for (const registration of mcpRegistrations) {
    mkdirSync(path.dirname(registration.absolute), { recursive: true });
    writeFileSync(registration.absolute, registration.content, 'utf8');
    clack.log.success(`${registration.existing ? 'Updated' : 'Created'} ${registration.relative} (e2e mcp server)`);
  }
  if (mcpFiles.length === 0) {
    clack.log.info('Skipped the MCP server; register it later with: claude mcp add e2e -- npx e2e mcp');
  }
  if (missingIgnore.length > 0) {
    const prefix = existingIgnore === '' || existingIgnore.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignorePath, `${existingIgnore}${prefix}${missingIgnore.join('\n')}\n`, 'utf8');
    clack.log.success(`Updated .gitignore (${missingIgnore.length} entries)`);
    if (missingIgnore.includes(CACHE_IGNORE_ENTRY)) {
      clack.log.info(`${CACHE_IGNORE_ENTRY} is ignored; committing agent.act replays is opt-in, see ${DOCS_URL}/cache#commit-your-traces`);
    }
  }

  if (install) {
    const result = spawnSync(manager, ['install'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error !== undefined || result.status !== 0) {
      const reason = result.error?.message ?? `exit ${result.status ?? result.signal}`;
      clack.log.error(`Installation failed (${reason}); retry with ${manager} install`);
      clack.outro('Scaffold saved');
      return done('install-failed', result.signal === 'SIGINT' ? 130 : 2);
    }
  }
  if (!existsSync(path.join(cwd, 'tsconfig.json'))) {
    clack.log.info('No tsconfig.json; add one for editor completions on e2e.config.ts and tests/');
  }
  // The script init adds, unless the project already had one of its own under that name.
  const runCommand = /^e2e run(?:\s|$)/u.test(manifest.scripts?.[RUN_SCRIPT] ?? '')
    ? runScriptCommand(manager, RUN_SCRIPT)
    : execCommand(manager, 'e2e run');
  // A subscription gateway has no key to set; the sign-in is the step before the first run.
  const subscription = model === undefined ? undefined : getGatewayPreset(model.gateway).login;
  const next = [
    options.directory === undefined ? undefined : `cd ${shellArgument(options.directory)}`,
    install ? undefined : `${manager} install`,
    subscription === undefined ? undefined : execCommand(manager, `e2e login ${subscription}`),
    `${scaffold.needsAppUrl ? 'APP_URL=http://localhost:3000 ' : ''}${runCommand}`,
  ].filter((step) => step !== undefined);
  clack.outro(`Next: ${next.join(', then ')}`);
  return done('scaffolded', 0);
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
  if (trimmed === '') return 'Enter the base URL, e.g. http://127.0.0.1:11434/v1';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `Not a URL: ${trimmed}`;
  }
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) return undefined;
  return 'Must use HTTPS unless the host is loopback';
}

/** Cancellation is only reachable before the first write, so nothing needs undoing. */
/**
 * `@clack/core` 1.5 narrows `isCancel` to its unique cancel symbol while the
 * prompts still resolve to `Value | symbol`, so the guard alone no longer
 * removes `symbol` from a prompt result. This one does.
 */
/**
 * Where an agent-facing artifact (the skill, the MCP registration) goes: the
 * locations an earlier run chose, refreshed and never extended; for a project
 * without one, every known location under `--yes`, else the user's pick.
 */
async function chooseLocations(
  found: readonly string[],
  locations: readonly { readonly value: string; readonly hint: string }[],
  message: string,
  yes: boolean | undefined,
): Promise<readonly string[] | symbol> {
  if (found.length > 0) return found;
  if (yes) return locations.map((location) => location.value);
  return clack.multiselect<string>({
    message,
    options: locations.map(({ value, hint }) => ({ value, label: value, hint })),
    initialValues: locations.map((location) => location.value),
    required: false,
  });
}

function isCancelled<Value>(value: Value | symbol): value is symbol {
  return clack.isCancel(value);
}

function cancelled(): number {
  clack.cancel('Cancelled; no changes were made');
  return 0;
}
