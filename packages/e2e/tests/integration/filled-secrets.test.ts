/**
 * A filled secret never leaves the runner in an artifact or in the cache.
 * Through the real web engine: a text download is rewritten, labelled
 * `complete`, and handed to the store already clean whenever the session
 * knows the secret, filled or not. A secret filled into a visible ordinary
 * field denies screenshots. The executor's fill is recorded in the trace
 * cache by the secret's name alone. Nothing under the project's `.e2e`
 * directory holds the plaintext afterwards.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutorNode } from '../../src/agent/executor.ts';
import type { ArtifactStore, StoredArtifact } from '../../src/types.ts';
import type { RunOutcome } from '../../src/run/runner.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { contentsUnder, createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { entriesFor, readEntries } from '../helpers/trace-cache.ts';

const SECRET = 'filled-secret-Qx7#"&=2718';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';

test('fills through screen', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
});

test('fills through the executor', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('enter the password', { params: { password: credentials.user('member').password } });
  await expect(screen.getByLabel('Password')).toBeVisible();
});

test('fills nothing', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Focus target').fill('plain text');
});

test('downloads after a fill', async ({ app, screen, browser }) => {
  await app.open('/exports');
  await screen.getByLabel('Export key').fill(credentials.user('member').password);
  await browser.waitForDownload(() => screen.getByRole('link', { name: 'Download export' }).tap());
});

test('downloads without a fill', async ({ app, screen, browser }) => {
  await app.open('/downloads');
  await browser.waitForDownload(() => screen.getByRole('link', { name: 'Download report' }).tap());
});

test('fills a visible field', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Focus target').fill(credentials.user('member').password);
  const denied = await app.screenshot().then(() => undefined, (error: { code?: string }) => error.code);
  expect(denied).toBe('POLICY_DENIED');
});
`;

function capturing(): ArtifactStore & { puts: StoredArtifact[] } {
  const puts: StoredArtifact[] = [];
  return {
    puts,
    async put(artifact) {
      puts.push(artifact);
      return { ref: `store://${artifact.sha256.slice(0, 12)}` };
    },
  };
}

describe('filled secrets', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;
  const store = capturing();

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/secrets.e2e.ts': SUITE });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        cache: 'read-write' as const,
        artifacts: { store },
        credentials: { member: { username: 'ada', password: SECRET } },
        agents: {
          default: {
            executor: {
              name: 'secret-filler',
              async runStep(context) {
                const observation = await context.observe({ tree: true });
                const find = (match: (node: ExecutorNode) => boolean) =>
                  (function walk(node: ExecutorNode): ExecutorNode | undefined {
                    if (match(node)) return node;
                    for (const child of node.children ?? []) {
                      const found = walk(child);
                      if (found !== undefined) return found;
                    }
                    return undefined;
                  })(observation.tree!);
                // Declared secrets are keyed by the credential's name, not the param's.
                await context.actions.typeSecret({ id: find((node) => node.states?.secure === true)!.id }, 'member.password');
                // A secure field never shows its value, so the fill alone leaves nothing a replay
                // could check; the counter is the step's visible effect, which makes it recordable.
                await context.actions.tap({ id: find((node) => node.role === 'button' && node.name === 'Increment')!.id });
                return { status: 'passed', summary: 'filled' };
              },
            },
          },
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes every test', () => {
    const failures = outcome.report.run.results
      .flatMap((result) => result.attempts)
      .flatMap((attempt) => (attempt.error === undefined ? [] : [attempt.error]));
    expect(outcome.status, JSON.stringify({ runErrors: outcome.report.run.errors, failures }, null, 2)).toBe('passed');
  });

  it('downloads after a fill: a text download is rewritten, labelled complete, and stored clean', () => {
    const attempt = resultByTitle(outcome, 'downloads after a fill').attempts[0]!;
    const download = attempt.artifacts.find((artifact) => artifact.kind === 'download')!;
    expect(download).toMatchObject({ redaction: 'complete', mediaType: 'text/csv' });
    const onDisk = readFileSync(path.join(project.dir, '.e2e', 'artifacts', download.path!), 'utf8');
    expect(onDisk).toBe('id,key\n1,<secret:member.password>\n');
    const put = store.puts.find((stored) => stored.path === download.path)!;
    expect(put).toMatchObject({ kind: 'download', redaction: 'complete', sha256: download.sha256 });
    expect(Buffer.from(put.bytes).toString('utf8')).toBe(onDisk);
  });

  it('downloads without a fill: the text file is scanned, kept as served, and labelled complete', () => {
    const attempt = resultByTitle(outcome, 'downloads without a fill').attempts[0]!;
    const download = attempt.artifacts.find((artifact) => artifact.kind === 'download')!;
    expect(download).toMatchObject({ redaction: 'complete', mediaType: 'text/csv' });
    expect(readFileSync(path.join(project.dir, '.e2e', 'artifacts', download.path!), 'utf8')).toBe('id,total\n1,42\n');
    expect(store.puts.find((stored) => stored.path === download.path)).toMatchObject({ redaction: 'complete' });
  });

  it('records the executor fill in the cache by the secret name alone, with no value', () => {
    expect(readEntries(project)).toHaveLength(1);
    const [entry] = entriesFor(project, 'fills through the executor');
    expect(entry!.payload.actions).toEqual([
      {
        name: 'typeSecret',
        summary: expect.stringContaining('member.password'),
        target: expect.objectContaining({ role: 'textbox', name: 'Password' }),
        secret: 'member.password',
      },
      expect.objectContaining({ name: 'tap', target: expect.objectContaining({ role: 'button', name: 'Increment' }) }),
    ]);
  });

  it('leaves the plaintext nowhere under .e2e, in the report, or in what the store received', () => {
    expect(JSON.stringify(outcome.report)).not.toContain(SECRET);
    for (const put of store.puts) {
      expect(Buffer.from(put.bytes).includes(SECRET), put.path).toBe(false);
    }
    for (const [file, text] of contentsUnder(path.join(project.dir, '.e2e'))) expect(text.includes(SECRET), file).toBe(false);
  });
});
