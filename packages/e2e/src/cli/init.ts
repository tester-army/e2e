/** Non-destructive project scaffolding. */

import * as clack from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { esmPackageHint } from '../config/esm.ts';
import { findInstalledSkillDirs, planSkillInstall, SKILL_LOCATIONS } from './init/agent-skill.ts';
import { getEnginePresets, DEFAULT_ENGINE_ID, type EngineId } from './init/engines.ts';
import { addDependencies, detectPackageManager, readPackage, serializePackage } from './init/package.ts';
import { createScaffold } from './init/scaffold.ts';
import { MISSING_SKILL_MESSAGE, readSkillFiles } from './skill.ts';

export interface InitOptions {
  yes?: boolean;
}

const GITIGNORE_ENTRIES = [
  'node_modules/',
  '.e2e/artifacts/',
  '.e2e/cache/',
  '.e2e/sessions/',
  '.e2e/report.json',
  '.e2e/ai-trace.json',
  '.e2e/junit.xml',
  '.e2e/logs/',
];

/**
 * Runs `e2e init`. Every prompt happens before the first write, existing
 * config and test files are never touched, and dependencies install only when
 * the user asks. The agent skill is offered once; later runs refresh the
 * copies that exist and never add new locations.
 */
export async function init(cwd: string, options: InitOptions = {}): Promise<number> {
  clack.intro('e2e init');

  let pkg: ReturnType<typeof readPackage>;
  try {
    pkg = readPackage(cwd);
  } catch {
    clack.log.error('invalid package.json; fix it before running e2e init');
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
  if (pkg.original !== undefined) {
    const hint = esmPackageHint(path.join(cwd, existingConfig ?? 'e2e.config.ts'));
    if (hint !== undefined) clack.log.warn(hint);
  }

  const gitignorePath = path.join(cwd, '.gitignore');
  const existingIgnore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const ignoreLines = existingIgnore.split(/\r?\n/);
  const missingIgnore = GITIGNORE_ENTRIES.filter((entry) => !ignoreLines.includes(entry));

  // Engine and AI are choices for a new config only; an existing config keeps its own dependencies.
  let engine: EngineId = DEFAULT_ENGINE_ID;
  let ai = existingConfig === undefined;
  if (existingConfig === undefined && !options.yes) {
    const selectedEngine = await clack.select<EngineId>({
      message: 'Which engine?',
      initialValue: DEFAULT_ENGINE_ID,
      options: getEnginePresets().map(({ id, label, hint }) => ({ value: id, label, hint })),
    });
    if (clack.isCancel(selectedEngine)) return cancelled();
    engine = selectedEngine;

    const enableAi = await clack.confirm({ message: 'Enable AI testing? Adds AI SDK v7.', initialValue: true });
    if (clack.isCancel(enableAi)) return cancelled();
    ai = enableAi;
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

  const scaffold = createScaffold(engine, ai);
  const { manifest, additions } = addDependencies(pkg.manifest, scaffold.dependencies);
  if (additions.length > 0) {
    clack.log.info(`add dev dependencies: ${additions.map(([name, version]) => `${name}@${version}`).join(', ')}`);
  }

  const files = [
    ...(pkg.original === undefined || additions.length > 0
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

  const manager = detectPackageManager(cwd, manifest);
  let install = false;
  if (!options.yes) {
    const selected = await clack.confirm({ message: `Install dependencies with ${manager}?`, initialValue: true });
    if (clack.isCancel(selected)) return cancelled();
    install = selected;
  }

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
    clack.log.info('skipped the agent skill; agents can still print it with npx --no-install e2e guide');
  }
  if (missingIgnore.length > 0) {
    const prefix = existingIgnore === '' || existingIgnore.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignorePath, `${existingIgnore}${prefix}${missingIgnore.join('\n')}\n`, 'utf8');
    clack.log.success(`updated .gitignore (${missingIgnore.length} entries)`);
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
  clack.outro(`next: ${install ? '' : `${manager} install, then `}${scaffold.runCommand}`);
  return 0;
}

/** Cancellation is only reachable before the first write, so nothing needs undoing. */
function cancelled(): number {
  clack.cancel('cancelled; no changes were made');
  return 0;
}
