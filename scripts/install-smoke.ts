/**
 * A first install, the way a new user meets it: packs the built `e2e`,
 * `@e2e-dev/web`, and `@e2e-dev/mobile`, installs them with a given pnpm
 * into a fresh project outside this repository, installs again from the
 * lockfile, typechecks a custom mobile tool, and runs a TypeScript test
 * through the installed CLI. `e2e-core` is packed too and reaches the
 * project only through `e2e`'s dependency and the engines' peer, as it does
 * for a user, and the install must hold one copy of it: two would split the
 * error classes and the engine registry between the runner and the engines.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './public-packages.ts';

const pnpmVersion = process.argv[2];
if (pnpmVersion === undefined) {
  process.stderr.write('usage: node scripts/install-smoke.ts <pnpm version>\n');
  process.exit(2);
}

/** The packages a new user installs: the runner and its engines, and the core both build on. */
const PACKAGES = ['core', 'e2e', 'web', 'mobile'] as const;

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

const driverVersion = process.env['AGENT_DEVICE_VERSION'];
const pnpm = (args: readonly string[]) => run(project, 'npx', ['--yes', `pnpm@${pnpmVersion}`, ...args]);

const mobileManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/mobile/package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const problems: string[] = [];
let workspaceYaml: string | undefined;
try {
  for (const name of PACKAGES) {
    const packed = run(join(REPO_ROOT, 'packages', name), 'pnpm', ['pack', '--pack-destination', tarballs]);
    if (packed.status !== 0) throw new Error(`pnpm pack failed in packages/${name}:\n${packed.output}`);
  }
  const files = readdirSync(tarballs);
  const tarball = (prefix: string): string => `file:${join(tarballs, files.find((file) => file.startsWith(prefix))!)}`;
  // `e2e` names its exact `e2e-core`, which the registry has not published yet: the override serves the tarball.
  workspaceYaml = `overrides:\n  e2e-core: ${JSON.stringify(tarball('e2e-core-'))}\n${driverVersion ? `  agent-device: ${JSON.stringify(driverVersion)}\n` : ''}`;
  writeFileSync(join(project, 'pnpm-workspace.yaml'), workspaceYaml);
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'install-smoke',
      private: true,
      type: 'module',
      devDependencies: {
        e2e: tarball('e2e-0'),
        '@e2e-dev/web': tarball('e2e-dev-web-'),
        '@e2e-dev/mobile': tarball('e2e-dev-mobile-'),
        typescript: mobileManifest.devDependencies['typescript'],
        '@types/node': mobileManifest.devDependencies['@types/node'],
        '@types/json-schema': '7.0.15',
        ai: mobileManifest.devDependencies['ai'],
        zod: mobileManifest.dependencies['zod'],
      },
    }),
  );
  writeFileSync(join(project, 'e2e.config.ts'), "import type { E2EConfig } from 'e2e';\n\nexport default { targets: [{ name: 'local', platform: 'test' }] } satisfies E2EConfig;\n");
  writeFileSync(
    join(project, 'tests', 'smoke.e2e.ts'),
    "import { expect, test } from 'e2e';\n\nenum Answer { Yes = 'yes' }\n\ntest('TypeScript runs', () => {\n  expect(Answer.Yes).toBe('yes');\n});\n",
  );

  writeFileSync(join(project, 'mobile-types.ts'), `
import { tool } from 'ai';
import { z } from 'zod';
import { defineTool } from 'e2e/agent';
import { mobile, type Device, type DeviceSessionClient } from '@e2e-dev/mobile';
import { unstable_deviceSession } from '@e2e-dev/mobile/tools';

const iphone = mobile({ platform: 'ios' });
const pixel = mobile({ platform: 'android' });
export const mobileData = defineTool(tool({
  description: 'Turn cellular mobile data on or off. Wi-Fi is not affected.',
  inputSchema: z.object({ on: z.boolean() }),
  execute: async ({ on }) => {
    const { client, selection } = unstable_deviceSession(iphone, pixel);
    await client.settings.update({ ...selection, setting: 'mobile-data', state: on ? 'on' : 'off' });
    return on ? 'mobile data is on' : 'mobile data is off';
  },
}), { mutates: true, platforms: ['android'] });

export async function checkFixture(device: Device) {
  const { client, selection } = device.unstable_raw;
  const typed: DeviceSessionClient = client;
  await typed.apps.list(selection);
  const { nodes } = await typed.capture.snapshot(selection);
  nodes.map((node) => node.identifier);
  // @ts-expect-error unknown settings are rejected.
  await typed.settings.update({ ...selection, setting: 'not-a-setting', state: 'on' });
  // @ts-expect-error unsupported states are rejected.
  await typed.settings.update({ ...selection, setting: 'mobile-data', state: 'invalid' });
  // @ts-expect-error snapshot nodes have known fields.
  nodes.map((node) => node.nonexistentField);
}
`);

  for (const [step, args] of [
    ['pnpm install', ['install']],
    ['pnpm install --frozen-lockfile', ['install', '--frozen-lockfile']],
    ['mobile tool types', ['exec', 'tsc', '--noEmit', '--strict', '--types', 'node,json-schema', '--module', 'NodeNext', '--target', 'ES2024', 'mobile-types.ts']],
    ['e2e run', ['exec', 'e2e', 'run', '--workers', '1']],
  ] as const) {
    const { status, output } = pnpm(args);
    process.stdout.write(`$ ${step}: exit ${status}\n`);
    if (status !== 0) problems.push(`${step} exited ${status}:\n${output}`);
    if (output.includes('ERR_PNPM_IGNORED_BUILDS')) problems.push(`${step} reported ERR_PNPM_IGNORED_BUILDS:\n${output}`);
    if (existsSync(join(project, 'pnpm-workspace.yaml')) && readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8') !== workspaceYaml) {
      problems.push(`${step} wrote or changed pnpm-workspace.yaml`);
    }
    if (problems.length > 0) break;
    if (args[0] === 'install') {
      const copies = readdirSync(join(project, 'node_modules', '.pnpm')).filter((dir) => dir.startsWith('e2e-core@'));
      if (copies.length !== 1) problems.push(`${step} installed ${copies.length} copies of e2e-core: ${copies.join(', ')}`);
    }
    if (driverVersion && args[0] === 'install') {
      const graph = pnpm(['list', 'agent-device', '--depth', 'Infinity', '--json']);
      const versions: string[] = [];
      /** Collects driver copies without confusing their parents' versions. */
      function collect(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'agent-device') versions.push(child.version);
          collect(child);
        }
      }
      collect(JSON.parse(graph.output));
      if (graph.status !== 0 || versions.length === 0 || versions.some((version) => version !== driverVersion)) {
        throw new Error(`Expected agent-device ${driverVersion}: ${graph.output}`);
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`install smoke: pnpm ${pnpmVersion} installs ${PACKAGES.join(', ')} with no build scripts, typechecks a mobile tool, and runs a TypeScript test\n`);
}
