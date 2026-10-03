/**
 * A first install, the way a new user meets it: packs the built `e2e`,
 * `@e2e-dev/web`, and `@e2e-dev/mobile`, installs them with a given pnpm
 * into a fresh project outside this repository, installs again from the
 * lockfile, and runs a TypeScript test through the installed CLI.
 *
 * pnpm 11 and later fail an install on any dependency build script the
 * project has not decided on (`ERR_PNPM_IGNORED_BUILDS`), and write a
 * `pnpm-workspace.yaml` asking for the decision. Either one fails this
 * check. `check-install-scripts.ts` names the package that would cause it;
 * this proves the install itself.
 *
 * Usage: `node scripts/install-smoke.ts <pnpm major or version>` after
 * `pnpm run build`, e.g. `node scripts/install-smoke.ts 11`. Needs the npm
 * registry for the published dependencies. Exits 1 naming what failed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './public-packages.ts';

const pnpmVersion = process.argv[2];
if (pnpmVersion === undefined) {
  process.stderr.write('usage: node scripts/install-smoke.ts <pnpm version>\n');
  process.exit(2);
}

/** The packages a new user installs: the runner and its engines. */
const PACKAGES = ['e2e', 'web', 'mobile'] as const;

const root = mkdtempSync(join(tmpdir(), 'e2e-install-smoke-'));
const tarballs = join(root, 'tarballs');
const project = join(root, 'project');
mkdirSync(tarballs);
mkdirSync(join(project, 'tests'), { recursive: true });

/** Runs `command` in `cwd`; returns its exit code and combined output. */
function run(cwd: string, command: string, args: readonly string[]): { status: number; output: string } {
  // pnpm's release-age gate would block a dependency bump for a day; this check is about build scripts.
  const env = { ...process.env, E2E_TELEMETRY_DISABLED: '1', pnpm_config_minimum_release_age: '0' };
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32' });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const pnpm = (args: readonly string[]) => run(project, 'npx', ['--yes', `pnpm@${pnpmVersion}`, ...args]);

const problems: string[] = [];
try {
  for (const name of PACKAGES) {
    const packed = run(join(REPO_ROOT, 'packages', name), 'pnpm', ['pack', '--pack-destination', tarballs]);
    if (packed.status !== 0) throw new Error(`pnpm pack failed in packages/${name}:\n${packed.output}`);
  }
  const files = readdirSync(tarballs);
  const tarball = (prefix: string): string => `file:${join(tarballs, files.find((file) => file.startsWith(prefix))!)}`;
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'install-smoke',
      private: true,
      type: 'module',
      devDependencies: { e2e: tarball('e2e-0'), '@e2e-dev/web': tarball('e2e-dev-web-'), '@e2e-dev/mobile': tarball('e2e-dev-mobile-') },
    }),
  );
  writeFileSync(join(project, 'e2e.config.ts'), "import type { E2EConfig } from 'e2e';\n\nexport default { targets: [{ name: 'local', platform: 'test' }] } satisfies E2EConfig;\n");
  writeFileSync(
    join(project, 'tests', 'smoke.e2e.ts'),
    "import { expect, test } from 'e2e';\n\nenum Answer { Yes = 'yes' }\n\ntest('TypeScript runs', () => {\n  expect(Answer.Yes).toBe('yes');\n});\n",
  );

  for (const [step, args] of [
    ['pnpm install', ['install']],
    ['pnpm install --frozen-lockfile', ['install', '--frozen-lockfile']],
    ['e2e run', ['exec', 'e2e', 'run', '--workers', '1']],
  ] as const) {
    const { status, output } = pnpm(args);
    process.stdout.write(`$ ${step}: exit ${status}\n`);
    if (status !== 0) problems.push(`${step} exited ${status}:\n${output}`);
    if (output.includes('ERR_PNPM_IGNORED_BUILDS')) problems.push(`${step} reported ERR_PNPM_IGNORED_BUILDS:\n${output}`);
    if (existsSync(join(project, 'pnpm-workspace.yaml'))) problems.push(`${step} wrote a pnpm-workspace.yaml`);
    if (problems.length > 0) break;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`install smoke: pnpm ${pnpmVersion} installs ${PACKAGES.join(', ')} with no build scripts and runs a TypeScript test\n`);
}
