/**
 * A secret never leaves the runner in an artifact. Through the real browser
 * engine: a credential filled by `screen.fill()` and one filled by an
 * executor's `typeSecret` each produce a trace whose every text entry is
 * redacted; so does an attempt that filled nothing but opened a page the app
 * renders the configured value on; a download that holds the value is deleted
 * and the attempt says why; the `headers` the engine injects and the cookie a
 * restored session sends read as `<secret:...>` in the trace's network
 * entries. Every kept trace is labelled `complete` and handed to the store
 * clean, and nothing under the project's `.e2e` directory holds a plaintext
 * value afterwards.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { web } from '@e2edev/web';
import { inflateEntry, readZip } from '../../src/internal/zip.ts';
import type { ArtifactStore, E2EConfig, StoredArtifact } from '../../src/types.ts';
import type { RunOutcome } from '../../src/run/runner.ts';
import { FIXTURE_COOKIE_VALUE, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';

type Attempt = RunOutcome['results'][number]['attempts'][number];

const SECRET = 'trace-secret-Qx7#"&=2718';
const HEADER = 'bypass-token-0123456789abcdef';
const COOKIE = FIXTURE_COOKIE_VALUE;

const SUITE = `import { test, credentials } from 'e2e';

test('fills through screen', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
});

test('fills through the executor', async ({ app, agent }) => {
  await app.open();
  await agent.act('enter the password', { params: { password: credentials.user('member').password } });
});

test('fills nothing', async ({ app, screen }) => {
  await app.open('/planted');
  await screen.getByLabel('Note').fill('plain text');
});
`;

const WEB_SUITE = `import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('downloads the planted report', async ({ app, web }) => {
  await app.open('/downloads');
  await web.waitForDownload(() => web.locator('a[download]').tap());
});

test('sends the restored cookie', { session: 'seeded' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
});
`;

const SETUP = `import { test, expect } from 'e2e';

test.setup('seed storage', { sessions: ['seeded'] }, async ({ app, screen, session }) => {
  await app.open('/storage');
  await screen.getByRole('button', { name: 'Save marker' }).tap();
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
  await session.save('seeded');
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

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
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

  /** The one trace of an attempt, read from disk as text entries. */
  function traceOf(attempt: Attempt): { record: Attempt['artifacts'][number]; entries: Map<string, string> } {
    const traces = attempt.artifacts.filter((artifact) => artifact.kind === 'trace');
    expect(traces).toHaveLength(1);
    const record = traces[0]!;
    expect(record.path).toBeDefined();
    return { record, entries: textEntries(readFileSync(path.join(project.dir, '.e2e', 'artifacts', record.path!))) };
  }

  beforeAll(async () => {
    app = await startFixtureApp({ planted: SECRET });
    project = createProject({
      'tests/secrets.e2e.ts': SUITE,
      'tests/web.e2e.ts': WEB_SUITE,
      'tests/auth.setup.e2e.ts': SETUP,
    });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        // The engine injects the header on every request to the app's site,
        // and a Playwright trace records request headers.
        targets: [
          { name: 'web', engine: web({ url: app.url, headers: { 'x-preview-bypass': HEADER } }) },
        ] as unknown as NonNullable<E2EConfig['targets']>,
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        cache: 'off' as const,
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
  }, 180_000);

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
      const { record: trace, entries } = traceOf(attempt);
      expect(trace).toMatchObject({ redaction: 'complete', mediaType: 'application/zip' });
      expect(attempt.secondaryErrors).toEqual([]);

      // A real trace: the actions and the network are there, and the fill is recorded, redacted.
      expect([...entries.keys()]).toEqual(expect.arrayContaining(['trace.trace', 'trace.network']));
      expect(entries.get('trace.trace')).toContain('"fill"');
      expect(entries.get('trace.trace')).toContain('<secret:member>');
      for (const [name, text] of entries) expect(text, name).not.toContain(SECRET);

      const onDisk = readFileSync(path.join(project.dir, '.e2e', 'artifacts', trace.path!));
      const put = store.puts.find((stored) => stored.path === trace.path)!;
      expect(put.sha256).toBe(trace.sha256);
      expect(Buffer.from(put.bytes).equals(onDisk)).toBe(true);
    },
  );

  it('fills nothing: a page rendering the configured value still gets its trace rewritten and labelled complete', () => {
    const attempt = resultByTitle(outcome, 'fills nothing').attempts[0]!;
    const { record: trace, entries } = traceOf(attempt);
    expect(trace).toMatchObject({ redaction: 'complete' });
    expect(attempt.secondaryErrors).toEqual([]);
    // The DOM snapshot held the value the app rendered; the rest of the page is as recorded.
    expect(entries.get('trace.trace')).toContain('<secret:member>');
    expect(entries.get('trace.trace')).toContain('plain text');
    for (const [name, text] of entries) expect(text, name).not.toContain(SECRET);
  });

  it('a download holding the value is deleted, recorded without a path, kept from the store, and explained', () => {
    const attempt = resultByTitle(outcome, 'downloads the planted report').attempts[0]!;
    const download = attempt.artifacts.find((artifact) => artifact.kind === 'download')!;
    expect(download).toMatchObject({ redaction: 'incomplete', producer: { kind: 'step' } });
    expect(download.path).toBeUndefined();
    expect(download.size).toBeUndefined();
    expect(download.sha256).toBeUndefined();
    expect(download.ref).toBeUndefined();
    // The step that produced it passed and still owns the record.
    const step = attempt.steps.find((candidate) => candidate.api === 'web.waitForDownload')!;
    expect(step.status).toBe('passed');
    expect(step.artifacts).toEqual([download.id]);
    expect(attempt.secondaryErrors).toEqual([
      expect.objectContaining({
        code: 'ARTIFACT_WITHHELD',
        phase: 'body',
        message: expect.stringContaining('was deleted because a registered secret value occurs in it'),
      }),
    ]);
    expect(store.puts.some((put) => put.kind === 'download')).toBe(false);
    const { record: trace } = traceOf(attempt);
    const downloadsDir = path.join(project.dir, '.e2e', 'artifacts', path.posix.dirname(trace.path!), '..', 'downloads');
    expect(!existsSync(downloadsDir) || readdirSync(downloadsDir).length === 0).toBe(true);
  });

  it('an injected header reads as its secret name in every trace, and its value in none', () => {
    const attempts = outcome.results.flatMap((result) => result.attempts);
    expect(attempts.length).toBeGreaterThanOrEqual(6);
    let named = 0;
    for (const attempt of attempts) {
      const { record: trace, entries } = traceOf(attempt);
      expect(trace.redaction).toBe('complete');
      const network = entries.get('trace.network') ?? '';
      expect(network).not.toContain(HEADER);
      if (network.includes('<secret:header.x-preview-bypass>')) named += 1;
    }
    expect(named).toBe(attempts.length);
  });

  it('a restored cookie reads as its secret name in the consumer trace, and its value in none', () => {
    const consumer = resultByTitle(outcome, 'sends the restored cookie').attempts[0]!;
    const { entries } = traceOf(consumer);
    const network = entries.get('trace.network') ?? '';
    expect(network).toContain('<secret:cookie.fixture>');
    for (const [name, text] of entries) expect(text, name).not.toContain(COOKIE);
    const setup = resultByTitle(outcome, 'seed storage').attempts[0]!;
    for (const [name, text] of traceOf(setup).entries) expect(text, name).not.toContain(COOKIE);
  });

  it('leaves no plaintext value under .e2e, in the report, or in what the store received', () => {
    const values = [SECRET, HEADER, COOKIE];
    const report = JSON.stringify(outcome.report);
    for (const value of values) expect(report).not.toContain(value);
    for (const put of store.puts) {
      for (const value of values) expect(Buffer.from(put.bytes).includes(value), `${put.path} ${value}`).toBe(false);
    }
    for (const file of filesUnder(path.join(project.dir, '.e2e'))) {
      const bytes = readFileSync(file);
      for (const value of values) expect(bytes.includes(value), `${file} ${value}`).toBe(false);
      if (file.endsWith('.zip')) {
        for (const [name, text] of textEntries(bytes)) {
          for (const value of values) expect(text, `${file}!${name} ${value}`).not.toContain(value);
        }
      }
    }
  });
});
