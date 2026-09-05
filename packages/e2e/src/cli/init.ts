/** Non-destructive project scaffolding (spec 06-cli.md). */

import * as clack from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { esmPackageHint } from '../config/esm.ts';
import { getBackendPresets, DEFAULT_BACKEND_ID, type BackendId } from './init/backends.ts';
import { addDependencies, detectPackageManager, readPackage, serializePackage } from './init/package.ts';
import { createScaffold } from './init/scaffold.ts';

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
];

/**
 * Runs `e2e init`. Every prompt happens before the first write, existing
 * config and test files are never touched, and dependencies install only when
 * the user asks.
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

  // Backend and AI are choices for a new config only; an existing config keeps its own dependencies.
  let backend: BackendId = DEFAULT_BACKEND_ID;
  let ai = existingConfig === undefined;
  if (existingConfig === undefined && !options.yes) {
    const selectedBackend = await clack.select<BackendId>({
      message: 'Which backend?',
      initialValue: DEFAULT_BACKEND_ID,
      options: getBackendPresets().map(({ id, label, hint }) => ({ value: id, label, hint })),
    });
    if (clack.isCancel(selectedBackend)) return cancelled();
    backend = selectedBackend;

    const enableAi = await clack.confirm({ message: 'Enable AI testing? Adds AI SDK v7.', initialValue: true });
    if (clack.isCancel(enableAi)) return cancelled();
    ai = enableAi;
  }

  const scaffold = createScaffold(backend, ai);
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

  if (files.length === 0 && missingIgnore.length === 0) {
    clack.outro('nothing to create; project already initialized');
    return 0;
  }

  if (!options.yes) {
    const actions = [
      ...files.map((file) => `${file.existing ? 'update' : 'create'} ${file.relative}`),
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
