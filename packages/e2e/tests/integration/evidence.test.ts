/**
 * The evidence pack a run writes, through the real runner over the fake
 * engine: on by default, sealed and valid at L1 by the format's own library,
 * a frame per step, a failure record on the step that failed, nothing with
 * `--no-evidence`, and no secret value anywhere in the sealed bytes.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openContainer, validate } from '@testmuai/evidence-cli';
import { describe, expect, it } from 'vitest';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { contentsUnder, runExisting, runProject } from '../helpers/run-project.ts';

const PASSWORD = 'hunter2-evidence-secret';

function fakeConfig(fake: FakeEngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
  return {
    targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }],
    actionTimeout: 300,
    credentials: { member: { username: 'ada', password: PASSWORD } },
    ...extra,
  } as E2EConfig;
}

const SUITE = `import { test, credentials, expect } from 'e2e';

test('opens and taps', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).tap();
});

test('fails on a wrong count', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button')).toHaveCount(2, { timeout: 200 });
});

test('fills a secret', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await screen.getByRole('button', { name: 'Submit' }).tap();
});
`;

/** The one pack under `<project>/.e2e/evidence`, or undefined. */
function packIn(dir: string): string | undefined {
  const evidenceDir = path.join(dir, '.e2e', 'evidence');
  if (!existsSync(evidenceDir)) return undefined;
  const packs = readdirSync(evidenceDir).filter((name) => name.endsWith('.evidence'));
  expect(packs).toHaveLength(1);
  return path.join(evidenceDir, packs[0]!);
}

describe('evidence pack', () => {
  it(
    'is written by default, sealed, valid at L1, with a frame per step and the failure on its step',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject({ 'tests/shop.e2e.ts': SUITE }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        const pack = packIn(project.dir);
        expect(pack).toBeDefined();
        expect(pack!.endsWith(`${outcome.report.run.id}.evidence`)).toBe(true);
        // Sealed: a zip file at the pack's path, not a directory.
        expect(readFileSync(pack!).subarray(0, 2).toString('latin1')).toBe('PK');
        const report = await validate(pack!, { profile: 'L1' });
        expect(report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        expect(report.valid).toBe(true);

        expect(report.status).toBe('finalized');
        const container = await openContainer(pack!);
        const manifest = (await container.readManifest())!;
        expect(manifest).toMatch(/"?tests"?:\s*3\b/);
        expect(manifest).toMatch(/"?passed"?:\s*2\b/);
        expect(manifest).toMatch(/"?failed"?:\s*1\b/);
        expect(manifest).toMatch(/"?name"?:\s*"?e2e"?/);

        const tests = await container.listTestIds();
        const byTitle = async (fragment: string): Promise<string> => {
          for (const id of tests) if ((await container.readResult(id))!.includes(fragment)) return id;
          throw new Error(`no test result mentions ${fragment}`);
        };
        const stepFolders = async (id: string): Promise<string[]> =>
          (await container.listDir(`tests/${id}/steps`)).filter((entry) => entry.isDir).map((entry) => entry.name);

        const passed = await byTitle('opens%20and%20taps');
        expect(await stepFolders(passed)).toHaveLength(2);
        for (const folder of await stepFolders(passed)) {
          expect(await container.exists(`tests/${passed}/steps/${folder}/screenshot.png`)).toBe(true);
        }
        const failed = await byTitle('wrong%20count');
        const folders = await stepFolders(failed);
        const failure = await container.readText(`tests/${failed}/steps/${folders.at(-1)}/failure.yaml`);
        expect(failure).toContain('ASSERTION_FAILED');
        expect(await container.exists('failure.yaml')).toBe(true);

        // The steps after the secret fill carry no frame.
        const secret = await byTitle('fills%20a%20secret');
        const secretFolders = (await stepFolders(secret)).toSorted();
        expect(await container.exists(`tests/${secret}/steps/${secretFolders.at(-1)}/screenshot.png`)).toBe(false);

        // No secret value in any entry of the sealed pack, nested trace archives included.
        const entries = contentsUnder(path.dirname(pack!));
        expect(entries.some(([name]) => name.includes('.evidence!tests/'))).toBe(true);
        for (const [name, text] of entries) expect(text, name).not.toContain(PASSWORD);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'keeps only the latest pack in its directory, so runs never pile up',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { project } = await runProject({ 'tests/shop.e2e.ts': SUITE }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        const second = await runExisting(project, { appUrl: FAKE_APP_URL, config: fakeConfig(createFakeEngine({ artifacts: true })) });
        const pack = packIn(project.dir);
        expect(pack!.endsWith(`${second.report.run.id}.evidence`)).toBe(true);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'is not written with --no-evidence, and the run then takes no step frames',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/shop.e2e.ts': SUITE },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake), runOptions: { noEvidence: true } },
      );
      try {
        expect(packIn(project.dir)).toBeUndefined();
        const passed = outcome.report.run.results.find((result) => result.titlePath.at(-1) === 'opens and taps')!;
        expect(passed.attempts.at(-1)!.artifacts.filter((artifact) => artifact.kind === 'screenshot')).toEqual([]);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'never changes the run: a run with no selected tests still exits as before and writes a valid empty pack',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/shop.e2e.ts': SUITE },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake), runOptions: { grep: [/nothing matches this/], passWithNoTests: true } },
      );
      try {
        expect(outcome.exitCode).toBe(0);
        // The run wrote its report, so it writes its pack: one with no tests, which the format accepts.
        const pack = packIn(project.dir);
        expect(pack).toBeDefined();
        expect((await validate(pack!, { profile: 'L1' })).valid).toBe(true);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );
});
