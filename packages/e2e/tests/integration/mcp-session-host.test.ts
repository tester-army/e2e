/**
 * The session host in-process on the fake engine: the headed flag reaches the
 * engine, an idle session closes itself, the TTL ends a session through the
 * step's own deadline, and an `open_session` that fails after the attempt
 * opened tears the attempt down and leaves the host ready for the next one.
 * The standalone attempt underneath records a host-driven step through the
 * session's secret ledger, as a run's attempt does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeEngine, type FakeEngineHandle } from '../helpers/fake-engine.ts';

const sessionModule = new URL('../../dist/mcp/session.js', import.meta.url).href;
const { SessionHost } = (await import(sessionModule)) as typeof import('../../src/mcp/session.ts');
const resolveModule = new URL('../../dist/config/resolve.js', import.meta.url).href;
const { resolveConfig } = (await import(resolveModule)) as typeof import('../../src/config/resolve.ts');
const secretsModule = new URL('../../dist/secrets.js', import.meta.url).href;
const { credentials } = (await import(secretsModule)) as typeof import('../../src/secrets.ts');
const standaloneModule = new URL('../../dist/run/standalone.js', import.meta.url).href;
const { openStandaloneAttempt } = (await import(standaloneModule)) as typeof import('../../src/run/standalone.ts');
const interactiveStepModule = new URL('../../dist/agent/interactive-step.js', import.meta.url).href;
const { openInteractiveStep } = (await import(interactiveStepModule)) as typeof import('../../src/agent/interactive-step.ts');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SessionHost', { timeout: 60_000 }, () => {
  let dir: string;
  let logs: string[];

  const host = (fake: FakeEngineHandle, options: { headed?: boolean; idleMs?: number; ttlMs?: number } = {}) => {
    const config = resolveConfig(
      { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine }], credentials: { admin: { username: 'admin', password: 'kiosk-pw' } } } as never,
      { projectRoot: dir, env: {} },
    );
    return new SessionHost({
      loadConfig: async () => config,
      env: {},
      headed: options.headed ?? false,
      log: (level, message) => logs.push(`${level}: ${message}`),
      idleMs: options.idleMs,
      ttlMs: options.ttlMs,
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-host-'));
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots the engine headed when asked and headless otherwise', async () => {
    const fake = createFakeEngine();
    const headed = host(fake, { headed: true });
    const text = await headed.open({});
    expect(text).toContain('), headed;');
    expect(fake.inits[0]?.headed).toBe(true);
    await headed.close('done');
    const headless = host(fake, { headed: false });
    await headless.open({});
    expect(fake.inits[1]?.headed).toBe(false);
    await headless.close('done');
    expect(fake.stats()).toMatchObject({ attemptsStarted: 2, attemptsEnded: 2, disposes: 2 });
  });

  it('closes the schema of every fixed tool: an argument it does not declare fails validation', () => {
    const specs = host(createFakeEngine()).toolSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(['open_session', 'tools', 'call', 'close_session']);
    const accepted: Record<string, Record<string, unknown>> = {
      open_session: { target: 'kiosk' },
      tools: { tool: 'tap' },
      call: { tool: 'tap', args: { target: 'n1' } },
      close_session: {},
    };
    for (const spec of specs) {
      expect(spec.inputSchema.safeParse(accepted[spec.name]).success, spec.name).toBe(true);
      const decorated = spec.inputSchema.safeParse({ ...accepted[spec.name], force: true });
      expect(decorated.success, spec.name).toBe(false);
      if (!decorated.success) expect(decorated.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
    }
  });

  it('closes an idle session and disposes the engine', async () => {
    const fake = createFakeEngine();
    const idle = host(fake, { idleMs: 300 });
    await idle.open({});
    expect(idle.isOpen).toBe(true);
    await sleep(1_000);
    expect(idle.isOpen).toBe(false);
    expect(logs.some((line) => line.includes('idle for'))).toBe(true);
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
  });

  it('ends a session at its TTL through the step deadline', async () => {
    const fake = createFakeEngine();
    const short = host(fake, { ttlMs: 1_000 });
    await short.open({});
    await sleep(3_000);
    expect(short.isOpen).toBe(false);
    expect(logs.some((line) => line.includes('exceeded its 1000 ms timeout'))).toBe(true);
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
  });

  it('keeps the credential registry of a session opened while the previous one closes', async () => {
    const fake = createFakeEngine();
    const first = host(fake);
    await first.open({});
    const closing = first.close('done');
    const second = host(fake);
    await second.open({});
    await closing;
    expect(credentials.user('admin').username).toBe('admin');
    await second.close('done');
    expect(() => credentials.user('admin')).toThrow(/only available while the e2e runner is active/);
  });

  it('tears down an attempt whose first observation failed, then opens the next one', async () => {
    let broken = true;
    const fake = createFakeEngine({
      observe: () => {
        if (broken) throw new Error('screen unavailable');
      },
    });
    const flaky = host(fake);
    await expect(flaky.open({})).rejects.toThrow(/screen unavailable/);
    expect(flaky.isOpen).toBe(false);
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
    broken = false;
    const text = await flaky.open({});
    expect(text).toContain('button "Submit"');
    await flaky.close('done');
    expect(fake.stats()).toMatchObject({ attemptsStarted: 2, attemptsEnded: 2, disposes: 2 });
  });
});

describe('the standalone attempt', { timeout: 60_000 }, () => {
  const SECRET = 'pw-7f3a-standalone';
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-standalone-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records and announces a host-driven step whose instruction spells a configured secret as its name', async () => {
    const fake = createFakeEngine();
    const config = resolveConfig(
      { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine }], credentials: { admin: { username: 'admin', password: SECRET } } } as never,
      { projectRoot: dir, env: {} },
    );
    const announced: string[] = [];
    const attempt = await openStandaloneAttempt({
      config,
      target: config.targets[0]!,
      headed: false,
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      artifactsRoot: path.join(dir, '.e2e', 'artifacts'),
      onProgress: (progress) => {
        if ('label' in progress) announced.push(progress.label);
      },
    });
    try {
      const step = await openInteractiveStep(attempt.agentRuntime, { instruction: `sign in with ${SECRET}`, timeout: 10_000 });
      await step.end({ status: 'passed', summary: 'signed in' });
      const [recorded] = attempt.steps.completed();
      expect(recorded).toMatchObject({ api: 'session', label: 'sign in with <secret:admin>', status: 'passed' });
      expect(announced).toEqual(['sign in with <secret:admin>', 'sign in with <secret:admin>']);
      expect(JSON.stringify(attempt.steps.all())).not.toContain(SECRET);
    } finally {
      expect(await attempt.close()).toEqual([]);
    }
  });
});
