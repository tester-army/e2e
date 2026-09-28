/**
 * A filled secret never leaves the runner in a trace or in the cache. Through
 * the real Playwright engine: a credential filled by `screen.fill()` and one
 * filled by an executor's `typeSecret` each produce a trace whose every text
 * entry is redacted, labelled `complete`, and handed to the store already
 * clean; an attempt that filled no secret keeps its trace as recorded,
 * labelled `not-required`. The executor's fill is recorded in the trace cache
 * by the secret's name alone. Nothing under the project's `.e2e` directory
 * holds the plaintext afterwards.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inflateEntry, readZip } from '../../src/internal/zip.ts';
import type { ArtifactStore, StoredArtifact } from '../../src/types.ts';
import type { RunOutcome } from '../../src/run/runner.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, filesUnder, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { entriesFor, readEntries } from '../helpers/trace-cache.ts';

const SECRET = 'trace-secret-Qx7#"&=2718';

const SUITE = `import { test } from '@e2edev/web';
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

test('downloads after a fill', async ({ app, screen, web }) => {
  await app.open('/exports');
  await screen.getByLabel('Export key').fill(credentials.user('member').password);
  await web.waitForDownload(() => screen.getByRole('link', { name: 'Download export' }).tap());
});

test('downloads without a fill', async ({ app, screen, web }) => {
  await app.open('/downloads');
  await web.waitForDownload(() => screen.getByRole('link', { name: 'Download report' }).tap());
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

/** The archive's text entries by name, decoded. */
function textEntries(bytes: Uint8Array): Map<string, string> {
  return new Map(
    readZip(bytes).flatMap((entry) => {
      try {
        return [[entry.name, new TextDecoder('utf-8', { fatal: true }).decode(inflateEntry(entry))] as const];
      } catch {
        return [];
      }
    }),
  );
}

describe('trace secrecy', () => {
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
        artifacts: { kinds: ['screenshot', 'trace'], store },
        credentials: { member: { username: 'ada', password: SECRET } },
        agents: {
          default: {
            executor: {
              name: 'secret-filler',
              async runStep(context) {
                const observation = await context.observe({ tree: true });
                const secure = (function find(node): { id: string } | undefined {
                  if (node.states?.secure === true) return node;
                  for (const child of node.children ?? []) {
                    const found = find(child);
                    if (found !== undefined) return found;
                  }
                  return undefined;
                })(observation.tree!);
                // Declared secrets are keyed by the credential's name, not the param's.
                await context.actions.typeSecret({ id: secure!.id }, 'member');
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

  it.each(['fills through screen', 'fills through the executor'])(
    '%s: the trace is rewritten, labelled complete, and stored clean',
    (title) => {
      const attempt = resultByTitle(outcome, title).attempts[0]!;
      const trace = attempt.artifacts.find((artifact) => artifact.kind === 'trace')!;
      expect(trace).toMatchObject({ redaction: 'complete', mediaType: 'application/zip' });
      expect(trace.path).toBeDefined();
      expect(attempt.secondaryErrors).toEqual([]);

      const onDisk = readFileSync(path.join(project.dir, '.e2e', 'artifacts', trace.path!));
      const entries = textEntries(onDisk);
      // A real trace: the actions and the network are there, and the fill is recorded, redacted.
      expect([...entries.keys()]).toEqual(expect.arrayContaining(['trace.trace', 'trace.network']));
      expect(entries.get('trace.trace')).toContain('"fill"');
      expect(entries.get('trace.trace')).toContain('<secret:member>');
      for (const [name, text] of entries) expect(text, name).not.toContain(SECRET);

      const put = store.puts.find((stored) => stored.path === trace.path)!;
      expect(put.sha256).toBe(trace.sha256);
      expect(Buffer.from(put.bytes).equals(onDisk)).toBe(true);
    },
  );

  it('fills nothing: the trace is kept as recorded and labelled not-required', () => {
    const attempt = resultByTitle(outcome, 'fills nothing').attempts[0]!;
    const trace = attempt.artifacts.find((artifact) => artifact.kind === 'trace')!;
    expect(trace).toMatchObject({ redaction: 'not-required' });
    expect(trace.path).toBeDefined();
    const entries = textEntries(readFileSync(path.join(project.dir, '.e2e', 'artifacts', trace.path!)));
    expect(entries.get('trace.trace')).toContain('plain text');
  });

  it('downloads after a fill: a text download is rewritten, labelled complete, and stored clean', () => {
    const attempt = resultByTitle(outcome, 'downloads after a fill').attempts[0]!;
    const download = attempt.artifacts.find((artifact) => artifact.kind === 'download')!;
    expect(download).toMatchObject({ redaction: 'complete', mediaType: 'text/csv' });
    const onDisk = readFileSync(path.join(project.dir, '.e2e', 'artifacts', download.path!), 'utf8');
    expect(onDisk).toBe('id,key\n1,<secret:member>\n');
    const put = store.puts.find((stored) => stored.path === download.path)!;
    expect(put).toMatchObject({ kind: 'download', redaction: 'complete', sha256: download.sha256 });
    expect(Buffer.from(put.bytes).toString('utf8')).toBe(onDisk);
  });

  it('downloads without a fill: the file is kept as served and labelled incomplete', () => {
    const attempt = resultByTitle(outcome, 'downloads without a fill').attempts[0]!;
    const download = attempt.artifacts.find((artifact) => artifact.kind === 'download')!;
    expect(download).toMatchObject({ redaction: 'incomplete', mediaType: 'text/csv' });
    expect(readFileSync(path.join(project.dir, '.e2e', 'artifacts', download.path!), 'utf8')).toBe('id,total\n1,42\n');
    expect(store.puts.find((stored) => stored.path === download.path)).toMatchObject({ redaction: 'incomplete' });
  });

  it('records the executor fill in the cache by the secret name alone, with no value', () => {
    expect(readEntries(project)).toHaveLength(1);
    const [entry] = entriesFor(project, 'fills through the executor');
    expect(entry!.payload.actions).toEqual([
      {
        name: 'typeSecret',
        summary: expect.stringContaining('member'),
        target: expect.objectContaining({ role: 'textbox', name: 'Password' }),
        secret: 'member',
      },
    ]);
  });

  it('leaves the plaintext nowhere under .e2e, in the report, or in what the store received', () => {
    expect(JSON.stringify(outcome.report)).not.toContain(SECRET);
    for (const put of store.puts) {
      expect(Buffer.from(put.bytes).includes(SECRET), put.path).toBe(false);
    }
    for (const file of filesUnder(path.join(project.dir, '.e2e'))) {
      const bytes = readFileSync(file);
      expect(bytes.includes(SECRET), file).toBe(false);
      if (file.endsWith('.zip')) {
        for (const [name, text] of textEntries(bytes)) expect(text, `${file}!${name}`).not.toContain(SECRET);
      }
    }
  });
});
