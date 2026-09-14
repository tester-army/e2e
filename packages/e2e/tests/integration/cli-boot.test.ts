/**
 * The CLI starts without the optional `ai` peer dependency. `e2e init` is the
 * first command a project runs, before its dependencies exist, and `npx e2e`
 * installs the package with no peers at all. The built CLI is spawned under a
 * resolve hook that fails `ai` the way a missing package does; a static import
 * anywhere on the CLI's module graph fails this before argv is parsed.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** Registers a synchronous resolve hook (Node 22.15+) that fails `ai` the way a missing package does. */
const HOOK = [
  "import { registerHooks } from 'node:module';",
  'registerHooks({',
  '  resolve(specifier, context, next) {',
  "    if (specifier === 'ai' || specifier.startsWith('ai/')) {",
  "      const error = new Error(`Cannot find package 'ai' imported from ${context.parentURL}`);",
  "      error.code = 'ERR_MODULE_NOT_FOUND';",
  '      throw error;',
  '    }',
  '    return next(specifier, context);',
  '  },',
  '});',
].join('\n');
/** `--import` this and `ai` is unresolvable for the rest of the process. */
const WITHOUT_AI = ['--import', `data:text/javascript,${encodeURIComponent(HOOK)}`];

describe('the CLI without the ai package', () => {
  it('is really without it: the hook fails the import the way a missing package does', async () => {
    const script = "await import('ai').then(() => process.stdout.write('resolved'), (error) => process.stdout.write(error.code));";
    const { stdout } = await execFileAsync(process.execPath, [...WITHOUT_AI, '--input-type=module', '-e', script]);
    expect(stdout).toBe('ERR_MODULE_NOT_FOUND');
  });

  it('answers --version and --help', async () => {
    const version = await execFileAsync(process.execPath, [...WITHOUT_AI, CLI, '--version']);
    expect(version.stdout.trim()).toBe(VERSION);
    const help = await execFileAsync(process.execPath, [...WITHOUT_AI, CLI, '--help']);
    expect(help.stdout).toContain('init');
  });
});
