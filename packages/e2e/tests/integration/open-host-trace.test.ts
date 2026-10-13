/** Each hosted session writes its own trace page and keeps only the video its outcome retains. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { contentsUnder } from '../helpers/run-project.ts';
import { hostHarness, sdkExpect, secrets } from '../helpers/open-host.ts';

describe('openHost: trace', { timeout: 60_000 }, () => {
  const { host, config, dir } = hostHarness();

  it.each(['failed', 'passed'] as const)('records hosted retain-on-failure video and only keeps a %s session file', async (status) => {
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: `hosted video ${status}` });
    expect(fake.operations.filter((operation) => operation.method === 'artifacts.startVideo')).toHaveLength(1);
    await session.fixtures.app.open();
    if (status === 'failed') sdkExpect.soft(1, 'video soft failure').toBe(2);
    const failures = await session.close();
    expect(failures.map((failure) => failure.code)).toEqual(status === 'failed' ? ['ASSERTION_FAILED'] : []);
    expect(fake.operations.filter((operation) => operation.method === 'artifacts.stopVideo')).toHaveLength(1);
    const video = path.join(session.artifactsDir, 'video', 'fake.webm');
    expect(existsSync(video)).toBe(status === 'failed');
    const trace = readFileSync(session.tracePath, 'utf8');
    if (status === 'failed') {
      expect(readFileSync(video).length).toBeGreaterThan(0);
      const links = [...trace.matchAll(/\]\(([^)]+)\)/g)].map((match) => decodeURIComponent(match[1]!));
      expect(links.some((link) => path.resolve(path.dirname(session.tracePath), link) === video)).toBe(true);
      expect(trace).toContain('ASSERTION_FAILED');
    } else expect(trace).not.toContain('fake.webm');
    expect(await opened.close()).toEqual([]);
  });

  it('writes safe per-session trace pages with readable artifact links and redacted names and errors', async () => {
    const secret = 'host-secret-7Xq-91';
    const handle = secrets.get('hostToken');
    const fake = createFakeEngine({ fixtures: true, artifacts: true, secrets: [handle],
      onStartAttempt: async (context) => { await context.resolveSecret(handle); },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { hostToken: secret } }) });
    const name = `../../escape\\folder/<script>\u001b[31m ${secret}`;
    const traces: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const session = await opened.openSession({ name });
      await session.fixtures.app.screenshot(`home ${secret}`);
      await session.fixtures.gadget.dropFile();
      sdkExpect.soft(secret, `private ${secret}`).toBe('not the token');
      const failures = await session.close();
      const steps = session.steps();
      expect(JSON.stringify({ failures, steps })).not.toContain(secret);
      expect(path.isAbsolute(session.tracePath)).toBe(true);
      const relative = path.relative(path.join(dir(), '.e2e', 'results', 'host'), session.artifactsDir);
      expect(relative).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative.split(path.sep)).toHaveLength(1);
      expect(relative).not.toContain(secret);
      const trace = readFileSync(session.tracePath, 'utf8');
      expect(trace).toContain('app.screenshot');
      expect(trace).toContain('gadget.dropFile');
      expect(trace).toContain('ASSERTION_FAILED');
      expect(trace).not.toContain(secret);
      expect(trace).not.toContain('\u001b');
      expect(trace).not.toContain('<script>');
      const links = [...trace.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
      const localLinks = links.filter((link) => !/^[a-z][a-z\d+.-]*:/i.test(link) && !link.startsWith('#'));
      expect(localLinks.length).toBeGreaterThan(0);
      for (const link of localLinks) {
        expect(readFileSync(path.resolve(path.dirname(session.tracePath), decodeURIComponent(link)))).toBeDefined();
      }
      expect(readFileSync(path.join(session.artifactsDir, 'gadget', 'log.txt'), 'utf8')).toBe('gadget log\n');
      traces.push(session.tracePath);
    }
    expect(traces[0]).not.toBe(traces[1]);
    const output = path.join(dir(), '.e2e');
    for (const [file, content] of contentsUnder(output)) {
      expect(file).not.toContain(secret);
      expect(content, file).not.toContain(secret);
    }
  });
});
