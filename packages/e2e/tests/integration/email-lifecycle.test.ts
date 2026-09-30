/**
 * The `config.email` lifecycle through the real runner: retries, serial
 * groups, timeouts, interrupts, slow or failing providers, `test.extend`
 * fixtures, `afterEach` hooks, runtime skips, setup tests, the agent's tools,
 * and process workers. Each scenario runs its own project against an
 * instrumented in-memory provider that logs every call with the lease
 * address and whether the call's signal was already aborted.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { installFakeLoopModel } from '../helpers/fake-loop-model.ts';
import { memoryProvider, type MemoryProvider } from '../helpers/memory-mail.ts';
import { resultByTitle, runProject, runProjectWithConfigFile, workerConfigSource, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import type { MailLease, MailProvider } from '../../src/email/types.ts';

interface LogEntry {
  readonly at: number;
  readonly call: 'acquire' | 'acquired' | 'release' | 'released' | 'list' | 'read';
  readonly address?: string;
  readonly aborted: boolean;
}

interface StressProvider extends MailProvider {
  readonly log: LogEntry[];
  readonly base: MemoryProvider;
  addresses(call: LogEntry['call']): string[];
}

interface StressOptions {
  /** Delay before acquire resolves; ignores the signal when `honorSignal` is false. */
  acquireDelayMs?: number;
  /** Delay before release resolves. */
  releaseDelayMs?: number;
  releaseThrows?: boolean;
  /** Reject a call whose signal is aborted, as a fetch-based provider does. */
  honorSignal?: boolean;
}

function stressProvider(options: StressOptions = {}): StressProvider {
  const base = memoryProvider();
  const log: LogEntry[] = [];
  const note = (call: LogEntry['call'], signal: AbortSignal, address?: string) =>
    log.push({ at: Date.now(), call, ...(address === undefined ? {} : { address }), aborted: signal.aborted });
  const wait = async (ms: number | undefined, signal: AbortSignal) => {
    if (ms === undefined) return;
    await sleep(ms, undefined, options.honorSignal === true ? { signal } : {});
  };
  const check = (signal: AbortSignal) => {
    if (options.honorSignal === true) signal.throwIfAborted();
  };
  const provider: StressProvider = {
    name: 'stress',
    log,
    base,
    addresses: (call) => log.filter((entry) => entry.call === call).map((entry) => entry.address!),
    async acquire(context) {
      note('acquire', context.signal);
      check(context.signal);
      await wait(options.acquireDelayMs, context.signal);
      const lease = await base.acquire(context);
      note('acquired', context.signal, lease.address);
      return lease;
    },
    async release(lease: MailLease, context) {
      note('release', context.signal, lease.address);
      check(context.signal);
      await wait(options.releaseDelayMs, context.signal);
      if (options.releaseThrows === true) throw new Error('quota service is down');
      await base.release(lease, context);
      note('released', context.signal, lease.address);
    },
    async list(lease, context) {
      note('list', context.signal, lease.address);
      check(context.signal);
      return base.list(lease, context);
    },
    async read(lease, id, context) {
      note('read', context.signal, lease.address);
      check(context.signal);
      return base.read(lease, id, context);
    },
  };
  return provider;
}

let app: { url: string; close: () => Promise<void> };
const projects: FixtureProject[] = [];

beforeAll(async () => {
  const server: Server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><html><body><main><h1>Home</h1></main></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  app = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

afterAll(async () => {
  for (const project of projects) project.cleanup();
  await app?.close();
  delete (globalThis as Record<string, unknown>)['__stressMail'];
});

/** Runs one suite with `provider` as `config.email`, exposed to the suite as `globalThis.__stressMail`. */
async function runWith(
  provider: StressProvider,
  suite: string,
  config: Record<string, unknown> = {},
  runOptions: Record<string, unknown> = {},
): Promise<{ outcome: RunOutcome; ms: number }> {
  (globalThis as Record<string, unknown>)['__stressMail'] = provider;
  const started = Date.now();
  const { outcome, project } = await runProject(
    { 'tests/stress.e2e.ts': suite },
    { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', workers: 1, cache: 'off', email: provider, ...config }, runOptions },
  );
  projects.push(project);
  return { outcome, ms: Date.now() - started };
}

const HEADER = `import { test } from 'e2e';\nconst mail = globalThis.__stressMail;\n`;

describe('retries', () => {
  it('releases attempt 1 lease before attempt 2 leases a fresh address', async () => {
    const provider = stressProvider();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
globalThis.__tries ??= 0;
test('fails once', { retries: 1 }, async ({ email }) => {
  const inbox = await email.inbox();
  globalThis.__tries += 1;
  if (globalThis.__tries === 1) throw new Error('first attempt fails after leasing ' + inbox.address);
});
`,
    );
    const result = resultByTitle(outcome, 'fails once');
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
    const sequence = provider.log.filter((entry) => entry.call === 'acquired' || entry.call === 'released').map((entry) => `${entry.call}:${entry.address}`);
    expect(sequence).toEqual(['acquired:user1@memory.test', 'released:user1@memory.test', 'acquired:user2@memory.test', 'released:user2@memory.test']);
  }, 60_000);
});

describe('runtime skip, test.extend, afterEach', () => {
  it('releases after test.skip() at runtime, and after extend teardown and afterEach used the inbox', async () => {
    const provider = stressProvider();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test('skips after leasing', async ({ email }) => {
  await email.inbox();
  test.skip('decided at runtime');
});

const withAccount = test.extend({
  account: async ({ email }, use) => {
    const inbox = await email.inbox();
    await use(inbox);
    globalThis.__teardownSaw = (await inbox.messages()).length;
  },
});
test.describe('extended', () => {
  withAccount.afterEach(async ({ account }) => {
    globalThis.__afterEachSaw = (await account.messages()).length;
  });
  withAccount('extends with an inbox', async ({ account }) => {
    mail.base.deliver(account.address, { subject: 'hi' });
  });
});
`,
    );
    const skipped = resultByTitle(outcome, 'skips after leasing');
    expect(skipped.status, JSON.stringify(skipped.attempts[0]?.error)).toBe('skipped');
    const extended = resultByTitle(outcome, 'extends with an inbox');
    expect(extended.status, JSON.stringify(extended.attempts[0]?.error)).toBe('passed');
    expect((globalThis as Record<string, unknown>)['__afterEachSaw']).toBe(1);
    expect((globalThis as Record<string, unknown>)['__teardownSaw']).toBe(1);
    expect(provider.addresses('released').toSorted()).toEqual(provider.addresses('acquired').toSorted());
  }, 60_000);
});

describe('serial groups', () => {
  it('shares member 1 address with member 2 and releases once, at group end', async () => {
    const provider = stressProvider();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test.describe('group', { serial: true }, () => {
  test('member 1 leases', async ({ email }) => {
    globalThis.__groupInbox = await email.inbox();
    mail.base.deliver(globalThis.__groupInbox.address, { subject: 'Welcome' });
  });
  test('member 2 reads', async () => {
    const message = await globalThis.__groupInbox.waitForMessage({ subject: 'welcome', timeout: 3000 });
    if (message.subject !== 'Welcome') throw new Error('wrong message');
  });
});
`,
    );
    expect(resultByTitle(outcome, 'member 2 reads').status).toBe('passed');
    expect(provider.addresses('released')).toEqual(['user1@memory.test']);
  }, 60_000);

  it('stops member 2 poll of member 1 inbox when member 2 times out', async () => {
    const provider = stressProvider();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test.describe('group', { serial: true }, () => {
  test('member 1 leases', async ({ email }) => {
    globalThis.__groupInbox = await email.inbox();
  });
  test('member 2 waits past its timeout', { timeout: 1500 }, async () => {
    await globalThis.__groupInbox.waitForMessage({ subject: 'never', timeout: 8000 });
  });
});
`,
    );
    expect(resultByTitle(outcome, 'member 2 waits past its timeout').status).toBe('timed-out');
    const releasedAt = provider.log.find((entry) => entry.call === 'released')!.at;
    // A poll that outlived member 2 would list again after the group released the address.
    await sleep(5000);
    expect(provider.log.filter((entry) => entry.call === 'list' && entry.at > releasedAt)).toHaveLength(0);
  }, 60_000);
});

describe('serial group retries and setup tests', () => {
  it('releases each group attempt address once when a member fails mid-group and the group retries', async () => {
    const provider = stressProvider();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
globalThis.__groupTries ??= 0;
test.describe('group', { serial: true, retries: 1 }, () => {
  test('m1 leases', async ({ email }) => {
    globalThis.__groupInbox = await email.inbox();
  });
  test('m2 fails first time', async () => {
    globalThis.__groupTries += 1;
    if (globalThis.__groupTries === 1) throw new Error('flaky');
  });
  test('m3 reads', async () => {
    await globalThis.__groupInbox.messages();
  });
});
`,
    );
    expect(resultByTitle(outcome, 'm3 reads').status).toBe('flaky');
    const sequence = provider.log.filter((entry) => entry.call === 'acquired' || entry.call === 'released').map((entry) => `${entry.call}:${entry.address}`);
    expect(sequence).toEqual(['acquired:user1@memory.test', 'released:user1@memory.test', 'acquired:user2@memory.test', 'released:user2@memory.test']);
  }, 60_000);

  it('releases an address a setup test leased', async () => {
    const provider = stressProvider();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test.setup('signs up', { sessions: ['acct'] }, async ({ email, session }) => {
  globalThis.__setupAddress = (await email.inbox()).address;
  await session.save('acct');
});
test('uses the session', { session: 'acct' }, async () => {});
`,
    );
    expect(resultByTitle(outcome, 'uses the session').status).toBe('passed');
    expect(provider.addresses('released')).toEqual(provider.addresses('acquired'));
    expect(provider.addresses('acquired')).toHaveLength(1);
  }, 60_000);
});

describe('timeouts', () => {
  it('stops a waitForMessage poll at the test timeout and releases the lease', async () => {
    const provider = stressProvider();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test('waits past its timeout', { timeout: 1500 }, async ({ email }) => {
  const inbox = await email.inbox();
  await inbox.waitForMessage({ subject: 'never', timeout: 8000 });
});
`,
    );
    expect(resultByTitle(outcome, 'waits past its timeout').status).toBe('timed-out');
    expect(provider.addresses('released')).toEqual(['user1@memory.test']);
    const releasedAt = provider.log.find((entry) => entry.call === 'released')!.at;
    await sleep(3500);
    expect(provider.log.filter((entry) => entry.call === 'list' && entry.at > releasedAt)).toHaveLength(0);
  }, 60_000);

  it('releases an address whose acquire was still in flight when the test timed out', async () => {
    // A provider slower than the test timeout that finishes creating the inbox anyway (the HTTP request already landed).
    const provider = stressProvider({ acquireDelayMs: 3000 });
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test('times out while acquiring', { timeout: 1000 }, async ({ email }) => {
  await email.inbox();
});
`,
    );
    expect(resultByTitle(outcome, 'times out while acquiring').status).toBe('timed-out');
    await sleep(3500);
    expect(provider.addresses('acquired')).toEqual(['user1@memory.test']);
    expect(provider.addresses('released')).toEqual(['user1@memory.test']);
  }, 60_000);
});

describe('release failures', () => {
  it('keeps the verdict, fails the cleanup, and records the release error beside it', async () => {
    const provider = stressProvider({ releaseThrows: true });
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test('passes then release throws', async ({ email }) => {
  await email.inbox();
});
`,
    );
    const result = resultByTitle(outcome, 'passes then release throws');
    expect(result.status).toBe('passed');
    const attempt = result.attempts[0]!;
    expect(attempt.secondaryErrors).toEqual([
      expect.objectContaining({ phase: 'cleanup', code: 'EMAIL_PROVIDER_FAILED', message: 'email provider "stress" failed releasing user1@memory.test: quota service is down' }),
    ]);
    expect(attempt.cleanup).toBe('failed');
  }, 60_000);

  it('bounds a release that ignores its signal by cleanupTimeout', async () => {
    const provider = stressProvider({ releaseDelayMs: 9000 });
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test('passes then release hangs', async ({ email }) => {
  await email.inbox();
});
`,
      { cleanupTimeout: 1000 },
    );
    const attempt = resultByTitle(outcome, 'passes then release hangs').attempts[0]!;
    expect(attempt.durationMs).toBeLessThan(5000);
    expect(attempt.cleanup).toBe('failed');
    expect(attempt.secondaryErrors).toEqual([expect.objectContaining({ phase: 'cleanup', code: 'CLEANUP_TIMEOUT' })]);
  }, 60_000);
});

describe('interrupt', () => {
  it('releases leased addresses when the run is interrupted', async () => {
    // Honors its signal like a fetch-based client does.
    const provider = stressProvider({ honorSignal: true });
    const controller = new AbortController();
    const interrupting = (async () => {
      const deadline = Date.now() + 30_000;
      while (!provider.log.some((entry) => entry.call === 'list') && Date.now() < deadline) await sleep(50);
      controller.abort();
    })();
    const { outcome } = await runWith(
      provider,
      `${HEADER}
test('waits until interrupted', async ({ email }) => {
  const inbox = await email.inbox();
  await inbox.waitForMessage({ subject: 'never', timeout: 20000 });
});
`,
      {},
      { interruptSignal: controller.signal },
    );
    await interrupting;
    const result = resultByTitle(outcome, 'waits until interrupted');
    expect(result.status, JSON.stringify(result.attempts)).toBe('interrupted');
    const release = provider.log.find((entry) => entry.call === 'release');
    expect(release?.aborted).toBe(false);
    expect(provider.addresses('released')).toEqual(['user1@memory.test']);
  }, 60_000);
});

describe('agent tools', () => {
  it('lets the body read an email again after the agent step that read it timed out', async () => {
    const provider = stressProvider({ honorSignal: true });
    const model = installFakeLoopModel((call) => {
      const address = /address (\S+@memory\.test)/u.exec(call.prompt)?.[1] ?? '';
      if (call.turn === 1) return [{ toolName: 'wait_for_email', input: { address, subject: 'invite', timeout_seconds: 5 } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read it' } }];
    });
    const { outcome } = await runWith(
      provider,
      `${HEADER}
import { setTimeout as sleep } from 'node:timers/promises';
test('reads the invite after the agent did', async ({ app, agent, email }) => {
  const inbox = await email.inbox();
  mail.base.deliver(inbox.address, { subject: 'Invite', text: 'join us' });
  await app.open('/');
  await agent.act('read the invite at address ' + inbox.address, { timeout: 2500 });
  await sleep(3000);
  const [message] = await inbox.messages({ subject: 'invite' });
  if (message?.text !== 'join us') throw new Error('the invite did not read back');
});
`,
      { agents: { default: { model } } },
    );
    const result = resultByTitle(outcome, 'reads the invite after the agent did');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  }, 60_000);
});

describe('process workers', () => {
  it('re-imports a config holding a live provider in each worker', async () => {
    const logFile = path.join(process.cwd(), 'tests', 'tmp-projects', `stress-mail-${process.pid}.log`);
    rmSync(logFile, { force: true });
    onTestFinished(() => rmSync(logFile, { force: true }));
    const provider = `
  email: {
    name: 'file-log',
    async acquire() { const address = 'u' + Math.random().toString(36).slice(2) + '@file.test'; appendFileSync(${JSON.stringify(logFile)}, 'acquire ' + address + '\\n'); return { id: address, address }; },
    async release(lease) { appendFileSync(${JSON.stringify(logFile)}, 'release ' + lease.address + '\\n'); },
    async list() { return []; },
    async read() { throw new Error('none'); },
  },`;
    const source = `import { appendFileSync } from 'node:fs';\n${workerConfigSource(2, provider)}`;
    const suite = `import { test } from 'e2e';\n${[1, 2, 3, 4].map((n) => `test('leases ${n}', async ({ email }) => { await email.inbox(); });`).join('\n')}\n`;
    const { outcome, project } = await runProjectWithConfigFile({ 'tests/a.e2e.ts': suite, 'tests/b.e2e.ts': suite.replaceAll('leases', 'b leases') }, { appUrl: app.url, configSource: source.replace("workers: 2,", "workers: 2, tests: 'tests/**/*.e2e.ts',") });
    projects.push(project);
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.results.map((result) => result.status)).toEqual(Array(8).fill('passed'));
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines.filter((line) => line.startsWith('acquire'))).toHaveLength(8);
    expect(lines.filter((line) => line.startsWith('release'))).toHaveLength(8);
  }, 120_000);
});
