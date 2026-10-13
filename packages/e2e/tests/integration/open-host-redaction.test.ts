/** Nothing a hosted session learns about a secret reaches the external runner or another host. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { EngineHandle } from '../../src/engine/index.ts';
import type { E2EHost } from '../../src/runner.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { contentsUnder } from '../helpers/run-project.ts';
import { credentials, ENGINES, gate, hostHarness, openHost, provisioned, sdkModule, secrets, type GadgetFixtures } from '../helpers/open-host.ts';

describe('openHost: redaction', { timeout: 60_000 }, () => {
  const { host, config, dir } = hostHarness();

  it('redacts provider-valued session opening errors before an external runner can report them', async () => {
    const plaintext = 'opening-provider-secret-19JX';
    const token = secrets.get('openingToken');
    const fake = createFakeEngine({
      secrets: [token],
      onStartAttempt: async (context) => {
        const value = await context.resolveSecret(token);
        throw new Error(`start failed with ${value}`, { cause: new Error(`nested cause ${value}`) });
      },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { openingToken: () => plaintext } }) });
    const error: unknown = await opened.openSession({ name: 'failed launch' }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ category: 'infrastructure', code: 'ENGINE_FAILURE' });
    expect(inspect(error, { depth: 10 })).not.toContain(plaintext);
    expect(JSON.stringify(error)).not.toContain(plaintext);
    expect((error as Error).cause).toBeUndefined();
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 0 });
  });

  it('redacts static secrets from host initialization errors', async () => {
    const plaintext = 'host-init-secret-81XX';
    const fake = createFakeEngine({ onInit: () => { throw new Error(`init failed ${plaintext}`); } });
    const error: unknown = await openHost({ cwd: dir(), env: {}, config: config(fake.engine, { secrets: { initToken: plaintext } }) }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ category: 'infrastructure', code: 'ENGINE_FAILURE' });
    expect(inspect(error, { depth: 10 })).not.toContain(plaintext);
    expect(fake.stats().disposes).toBe(1);
  });

  it('redacts provider values resolved by an attempt from host finish failures and notices', async () => {
    const plaintext = 'provider-finish-secret-8Zq-22';
    const handle = secrets.get('finishToken');
    let resolved = '';
    let finishes = 0;
    const notices: string[] = [];
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: async (context) => {
      resolved = await context.resolveSecret(handle);
    } });
    const pool = provisioned(fake);
    const engine: EngineHandle = { ...pool.engine, async finish(info) {
      finishes += 1;
      info.log(`releasing ${resolved}`);
      throw new Error(`finish refused ${resolved}`);
    } };
    const opened = await host(engine, {
      config: config(engine, { secrets: { finishToken: () => plaintext } }),
      onNotice: (_target, message) => notices.push(message),
    });
    const session = await opened.openSession({ name: 'resolved during launch' });
    expect(resolved).toBe(plaintext);
    expect(await session.close()).toEqual([]);
    const failures = await opened.close();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('finish refused');
    expect(failures[0]?.message).toContain('<secret:finishToken>');
    expect(JSON.stringify(failures)).not.toContain(plaintext);
    expect(await opened.close()).toEqual(failures);
    await expect(opened[Symbol.asyncDispose]()).rejects.toMatchObject({
      message: expect.not.stringContaining(plaintext),
    });
    expect(finishes).toBe(1);
    for (const [file, content] of contentsUnder(path.join(dir(), '.e2e'))) {
      expect(file).not.toContain(plaintext);
      expect(content, file).not.toContain(plaintext);
    }
    expect(notices.join('\n')).toContain('releasing <secret:finishToken>');
    expect(notices.join('\n')).not.toContain(plaintext);
  });

  it.each(['short', '180-character'] as const)('never puts a %s provider-valued session name in paths or a clipped trace title', async (length) => {
    const plaintext = length === 'short' ? 'provider-path-secret-5Jx-12' : 'ProviderTitleSecret-'.repeat(10).slice(0, 180);
    if (length === '180-character') expect(plaintext).toHaveLength(180);
    const handle = secrets.get('titleToken');
    const resolved: string[] = [];
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: async (context) => {
      resolved.push(await context.resolveSecret(handle));
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { titleToken: () => plaintext } }) });
    const directories: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const session = await opened.openSession({ name: `${plaintext} readable suffix` });
      const segment = path.relative(path.join(dir(), '.e2e', 'results', 'host'), session.artifactsDir);
      expect(segment.split(path.sep)).toHaveLength(1);
      expect(segment).toMatch(/^host-session-[a-f0-9]+$/);
      expect(session.artifactsDir.toLowerCase()).not.toContain(plaintext.slice(0, 18).toLowerCase());
      expect(session.tracePath).toBe(path.join(session.artifactsDir, 'trace.md'));
      expect(await session.close()).toEqual([]);
      const trace = readFileSync(session.tracePath, 'utf8');
      expect(trace).toContain('secret:titleToken');
      expect(trace).toContain('readable suffix');
      expect(trace).not.toContain(plaintext);
      expect(trace).not.toContain(plaintext.slice(0, 18));
      directories.push(session.artifactsDir);
    }
    expect(resolved).toEqual([plaintext, plaintext]);
    expect(directories[0]).not.toBe(directories[1]);
    for (const [file, content] of contentsUnder(path.join(dir(), '.e2e'))) {
      expect(file.toLowerCase()).not.toContain(plaintext.slice(0, 18).toLowerCase());
      expect(content, file).not.toContain(plaintext.slice(0, 18));
    }
  });

  it.each(['before A opens', 'while A is live'] as const)('keeps A credentials, secrets and deferred purpose when B is constructed %s', async (timing) => {
    const deferredPassword = secrets.get('purposeProbe.password');
    const token = secrets.get('onlyA');
    const first = createFakeEngine({
      scene: () => [{ id: 'token', role: 'textbox', name: 'Token', value: '' }],
      secrets: [token],
      onStartAttempt: async (context) => {
        expect(credentials.user('registryAccount').username).toBe('account-A');
        expect(secrets.get('onlyA').name).toBe('onlyA');
        expect(deferredPassword.purpose).toBe('password');
        expect(await context.resolveSecret(token)).toBe('registry-token-A-91');
      },
    });
    const second = createFakeEngine();
    const a = await host(first.engine, { config: config(first.engine, {
      credentials: {
        registryAccount: { username: 'account-A', password: 'registry-password-A-91' },
        purposeProbe: { username: 'purpose-A', password: 'purpose-password-A-91' },
      },
      secrets: { onlyA: 'registry-token-A-91' },
    }) });
    const openB = () => host(second.engine, { config: config(second.engine, {
      credentials: { registryAccount: { username: 'account-B', password: 'registry-password-B-42' } },
      secrets: { onlyB: 'registry-token-B-42', 'purposeProbe.password': 'generic-purpose-B-42' },
    }) });
    let b: E2EHost<GadgetFixtures> | undefined;
    if (timing === 'before A opens') b = await openB();
    const sessionA = await a.openSession({ name: 'registry A' });
    if (timing === 'while A is live') b = await openB();
    expect(credentials.user('registryAccount').username).toBe('account-A');
    expect(deferredPassword.purpose).toBe('password');
    expect(secrets.get('onlyA').purpose).toBe('generic-secret');
    expect(() => secrets.get('onlyB')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
    await sessionA.fixtures.app.open();
    await sessionA.fixtures.screen.getByRole('textbox', 'Token').fill(secrets.get('onlyA'));
    expect(first.callsOf(sessionA.attemptId, 'perform')).toContainEqual(expect.objectContaining({
      action: expect.objectContaining({ kind: 'fill', value: 'registry-token-A-91' }),
    }));
    expect(await sessionA.close()).toEqual([]);
    const sessionB = await b!.openSession({ name: 'registry B' });
    expect(credentials.user('registryAccount').username).toBe('account-B');
    expect(secrets.get('onlyB').name).toBe('onlyB');
    expect(deferredPassword.purpose).toBe('generic-secret');
    expect(() => secrets.get('onlyA')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
    expect(await sessionB.close()).toEqual([]);
  });

  it.each(['alone', 'dormant A', 'live A'] as const)('evaluates B file-config secret references independently with %s', async (timing) => {
    const first = createFakeEngine();
    let a: E2EHost<GadgetFixtures> | undefined;
    let sessionA: Awaited<ReturnType<E2EHost<GadgetFixtures>['openSession']>> | undefined;
    if (timing !== 'alone') {
      a = await host(first.engine, { config: config(first.engine, {
        secrets: { onlyA: 'file-registry-value-A' },
        credentials: { registryAccount: { username: 'account-A', password: 'file-password-value-A' } },
      }) });
      if (timing === 'live A') sessionA = await a.openSession({ name: 'A during config evaluation' });
    }
    const entered = gate();
    const proceed = gate();
    const shared: Record<string, unknown> = { entered, proceed };
    const second = createFakeEngine({ onStartAttempt: async (context) => {
      const token = shared.token as Parameters<typeof context.resolveSecret>[0];
      expect(await context.resolveSecret(token)).toBe('file-registry-value-B');
    } });
    shared.two = second.engine;
    (globalThis as Record<string, unknown>)[ENGINES] = shared;
    const filename = path.join(dir(), 'registry-config.mts');
    writeFileSync(filename, `import { secrets } from ${JSON.stringify(sdkModule)};
      const shared = globalThis.${ENGINES};
      shared.token = secrets.get('onlyB');
      shared.entered.resolve();
      await shared.proceed.promise;
      const reference = secrets.get('onlyB');
      export default {
        secrets: { onlyB: 'file-registry-value-B' },
        targets: [{ name: 'kiosk', platform: 'kiosk', engine: { ...shared.two, secrets: [reference] }, app: ${JSON.stringify(FAKE_APP)} }]
      };`);
    const opening = host(second.engine, { config: filename });
    try {
      await Promise.race([entered.promise, opening.then(() => undefined)]);
      if (a !== undefined) {
        expect(secrets.get('onlyA').name).toBe('onlyA');
        expect(credentials.user('registryAccount').username).toBe('account-A');
        expect(() => secrets.get('onlyB')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
      }
    } finally {
      proceed.resolve();
    }
    const b = await opening;
    if (sessionA !== undefined) {
      expect(secrets.get('onlyA').name).toBe('onlyA');
      await sessionA.close();
    }
    const sessionB = await b.openSession({ name: 'B own file-config reference' });
    expect(secrets.get('onlyB').name).toBe('onlyB');
    expect(await sessionB.close()).toEqual([]);
  });
});
