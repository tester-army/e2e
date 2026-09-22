import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_CLI_SESSION, EVENT_RUN_COMPLETED, runCompletedEvent } from '../../src/telemetry/events.ts';
import { POSTHOG_HOST, POSTHOG_PROJECT_KEY } from '../../src/telemetry/posthog.ts';
import { collectEnvironment, fleetName, statedIdentity } from '../../src/telemetry/environment.ts';
import { preferencesPath, TelemetryStore } from '../../src/telemetry/store.ts';
import { NOTICE_VERSION, Telemetry, type TelemetryOptions } from '../../src/telemetry/telemetry.ts';
import { sampleReport } from '../helpers/sample-report.ts';

const temporaries: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-telemetry-'));
  temporaries.push(dir);
  return dir;
}

/** A path whose parent is a file, so no directory can be created there. */
function unwritableDir(): string {
  const blocker = path.join(tempDir(), 'blocker');
  writeFileSync(blocker, '');
  return path.join(blocker, 'e2e');
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SentBatch {
  readonly url: string;
  readonly body: {
    readonly api_key: string;
    readonly batch: readonly {
      readonly event: string;
      readonly timestamp: string;
      readonly properties: Record<string, unknown>;
    }[];
  };
}

/** A fetch that records every request and answers with `status`; like the real one, it refuses an aborted signal. */
function recordingFetch(status = 200): { calls: SentBatch[]; fetch: typeof fetch } {
  const calls: SentBatch[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as SentBatch['body'] });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, fetch: impl };
}

function create(overrides: Partial<TelemetryOptions> = {}) {
  const output: string[] = [];
  const sent = recordingFetch();
  const configDir = overrides.configDir ?? tempDir();
  const telemetry = new Telemetry({
    version: '1.2.3',
    env: {},
    cwd: tempDir(),
    configDir,
    fetch: sent.fetch,
    write: (text) => void output.push(text),
    ...overrides,
  });
  return { telemetry, output, sent, configDir };
}

describe('Telemetry', () => {
  it('is on by default, prints the notice once, and sends one batch with identity and environment', async () => {
    const { telemetry, output, sent, configDir } = create();
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.disabledBy).toBeUndefined();

    telemetry.notice();
    telemetry.notice();
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('e2e collects anonymous usage telemetry');
    expect(output[0]).toContain('e2e telemetry disable');
    expect(output[0]).toContain('E2E_TELEMETRY_DISABLED=1');
    expect(output[0]).toContain('/telemetry');
    expect(TelemetryStore.open(configDir)!.wasNotified(NOTICE_VERSION)).toBe(true);

    telemetry.session('run', ['--headed']);
    await telemetry.flush();

    expect(sent.calls).toHaveLength(1);
    const [call] = sent.calls;
    expect(call!.url).toBe(`${POSTHOG_HOST}/batch/`);
    expect(call!.body.api_key).toBe(POSTHOG_PROJECT_KEY);
    expect(call!.body.batch).toHaveLength(1);
    const [item] = call!.body.batch;
    expect(item!.event).toBe(EVENT_CLI_SESSION);
    expect(Date.parse(item!.timestamp)).not.toBeNaN();
    const { properties } = item!;
    expect(properties['command']).toBe('run');
    expect(properties['flags']).toEqual(['--headed']);
    expect(properties['distinct_id']).toBe(TelemetryStore.open(configDir)!.anonymousId);
    expect(properties['session_id']).toBe(telemetry.sessionId);
    expect(properties['project_id']).toMatch(/^[a-f0-9]{64}$/u);
    expect(properties['$lib']).toBe('e2e');
    expect(properties['$lib_version']).toBe('1.2.3');
    expect(properties['e2e_version']).toBe('1.2.3');
    expect(properties['$process_person_profile']).toBe(false);
    expect(properties['$geoip_disable']).toBe(true);
    expect(properties['ci']).toBe(false);
    expect(properties['ci_name']).toBeNull();
    expect(properties['fleet']).toBeNull();
    expect(properties['coding_agent']).toBeNull();
    expect(properties['os']).toBe(os.platform());
    expect(properties['arch']).toBe(os.arch());
    expect(properties['node_version']).toBe(process.versions.node);
    expect(properties['runtime']).toBe('node');
    expect(properties['runtime_version']).toBe(process.versions.node);
    expect(properties['sandbox']).toBeNull();
    expect(properties['first_run']).toBe(true);
    expect(properties['days_since_first_run']).toBe(0);
    expect(typeof properties['cpu_count']).toBe('number');
    expect(typeof properties['memory_gb']).toBe('number');
    expect(typeof properties['package_manager']).toBe('string');
  });

  it('tells a returning machine from a first run and counts the days since', async () => {
    const configDir = tempDir();
    const first = create({ configDir });
    first.telemetry.session('list', []);
    await first.telemetry.flush();
    expect(first.sent.calls[0]!.body.batch[0]!.properties['first_run']).toBe(true);

    const file = preferencesPath(configDir);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...saved, createdAt: new Date(Date.now() - 3.5 * 86_400_000).toISOString() }));
    const later = create({ configDir });
    later.telemetry.session('list', []);
    await later.telemetry.flush();
    const { properties } = later.sent.calls[0]!.body.batch[0]!;
    expect(properties['first_run']).toBe(false);
    expect(properties['days_since_first_run']).toBe(3);
    expect(properties['distinct_id']).toBe(saved['anonymousId']);
  });

  it('batches every event of an invocation into one request and then has nothing left', async () => {
    const { telemetry, sent } = create();
    telemetry.session('run', []);
    telemetry.record(runCompletedEvent(sampleReport(), []));
    await telemetry.flush();
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]!.body.batch.map((item) => item.event)).toEqual([EVENT_CLI_SESSION, EVENT_RUN_COMPLETED]);
    // The run event is stamped with the report's own finish time.
    expect(sent.calls[0]!.body.batch[1]!.timestamp).toBe('2026-09-08T10:00:05.000Z');

    await telemetry.flush();
    expect(sent.calls).toHaveLength(1);
  });

  it('sends the session first, named as the CLI last named it', async () => {
    const { telemetry, sent } = create();
    telemetry.record(runCompletedEvent(sampleReport(), []));
    telemetry.session('run');
    telemetry.session('run', ['--tag']);
    await telemetry.flush();
    const batch = sent.calls[0]!.body.batch;
    expect(batch.map((item) => item.event)).toEqual([EVENT_CLI_SESSION, EVENT_RUN_COMPLETED]);
    expect(batch[0]!.properties['flags']).toEqual(['--tag']);
    expect(batch[0]!.properties).not.toHaveProperty('exit_code');
  });

  it('stamps how the invocation ended on the session event alone', async () => {
    const { telemetry, sent } = create();
    telemetry.session('run');
    telemetry.record(runCompletedEvent(sampleReport(), []));
    telemetry.endSession(0);
    await telemetry.flush();
    const [session, run] = sent.calls[0]!.body.batch;
    expect(session!.properties['exit_code']).toBe(0);
    expect(session!.properties['error_code']).toBeNull();
    expect(session!.properties['duration_ms']).toBeGreaterThanOrEqual(0);
    // The run event keeps the report's exit code and never a session field.
    expect(run!.properties['exit_code']).toBe(1);
    expect(run!.properties).not.toHaveProperty('error_code');
  });

  it('names the first failure as the one that ended the command, folded like every code', async () => {
    const { telemetry, sent } = create();
    telemetry.session('run');
    telemetry.failSession('CONFIG_NOT_FOUND');
    telemetry.failSession('INVALID_CONFIG');
    telemetry.endSession(2);
    await telemetry.flush();
    expect(sent.calls[0]!.body.batch[0]!.properties['error_code']).toBe('CONFIG_NOT_FOUND');

    const folded = create();
    folded.telemetry.session('run');
    folded.telemetry.failSession('not-a-runner-code');
    folded.telemetry.endSession(1);
    await folded.telemetry.flush();
    expect(folded.sent.calls[0]!.body.batch[0]!.properties['error_code']).toBe('OTHER');
  });

  it('sends nothing for an invocation that never reached a command', async () => {
    const { telemetry, sent } = create();
    telemetry.endSession(2);
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
  });

  it('sends nothing for a session the CLI discarded', async () => {
    const { telemetry, sent } = create();
    telemetry.session('run');
    telemetry.discardSession();
    telemetry.endSession(0);
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
  });

  it('keeps the same project id across invocations on one machine and differs across machines', async () => {
    const cwd = tempDir();
    const configDir = tempDir();
    const first = create({ cwd, configDir });
    first.telemetry.session('list', []);
    await first.telemetry.flush();
    const second = create({ cwd, configDir });
    second.telemetry.session('list', []);
    await second.telemetry.flush();
    const other = create({ cwd });
    other.telemetry.session('list', []);
    await other.telemetry.flush();

    const projectOf = (batch: SentBatch[]): unknown => batch[0]!.body.batch[0]!.properties['project_id'];
    expect(projectOf(first.sent.calls)).toBe(projectOf(second.sent.calls));
    // Outside git the id is salted per machine; a different preferences file is a different machine.
    expect(projectOf(other.sent.calls)).not.toBe(projectOf(first.sent.calls));
  });

  it.each([
    ['E2E_TELEMETRY_DISABLED', { E2E_TELEMETRY_DISABLED: '1' }],
    ['DO_NOT_TRACK', { DO_NOT_TRACK: 'true' }],
  ] as const)('sends nothing and prints no notice when %s is set', async (reason, env) => {
    const { telemetry, output, sent } = create({ env });
    expect(telemetry.disabledBy).toBe(reason);
    expect(telemetry.enabled).toBe(false);
    telemetry.notice();
    telemetry.session('run', []);
    await telemetry.flush();
    expect(output).toEqual([]);
    expect(sent.calls).toEqual([]);
  });

  it('reads a variable set to 0 or false as unset', () => {
    expect(create({ env: { E2E_TELEMETRY_DISABLED: '0' } }).telemetry.enabled).toBe(true);
    expect(create({ env: { DO_NOT_TRACK: 'false' } }).telemetry.enabled).toBe(true);
    expect(create({ env: { E2E_TELEMETRY_DISABLED: ' ' } }).telemetry.enabled).toBe(true);
  });

  it('honors a saved opt-out across instances and lets the user opt back in', async () => {
    const configDir = tempDir();
    const first = create({ configDir });
    expect(first.telemetry.setEnabled(false)).toBe(preferencesPath(configDir));
    expect(first.telemetry.disabledBy).toBe('preference');

    const second = create({ configDir });
    expect(second.telemetry.disabledBy).toBe('preference');
    second.telemetry.notice();
    second.telemetry.session('run', []);
    await second.telemetry.flush();
    expect(second.output).toEqual([]);
    expect(second.sent.calls).toEqual([]);

    expect(second.telemetry.setEnabled(true)).toBe(preferencesPath(configDir));
    expect(second.telemetry.disabledBy).toBeUndefined();
  });

  it('drops an event recorded before the opt-out landed', async () => {
    const { telemetry, sent } = create();
    telemetry.session('telemetry', []);
    telemetry.setEnabled(false);
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
  });

  it('drops the batch when another process saved an opt-out while the command ran', async () => {
    const configDir = tempDir();
    const running = create({ configDir });
    running.telemetry.session('run', []);
    const other = create({ configDir });
    expect(other.telemetry.setEnabled(false)).toBe(preferencesPath(configDir));
    await running.telemetry.flush();
    expect(running.sent.calls).toEqual([]);
  });

  it('treats an unwritable preferences directory as off', async () => {
    const { telemetry, output, sent } = create({ configDir: unwritableDir() });
    expect(telemetry.disabledBy).toBe('store');
    expect(telemetry.setEnabled(true)).toBeUndefined();
    telemetry.notice();
    telemetry.session('run', []);
    await telemetry.flush();
    expect(output).toEqual([]);
    expect(sent.calls).toEqual([]);
  });

  it('attributes CI runs to the vendor, writes no preferences, and prints no notice', async () => {
    const { telemetry, output, sent, configDir } = create({ env: { CI: 'true', GITHUB_ACTIONS: 'true' } });
    telemetry.notice();
    telemetry.session('run', ['--reporter']);
    await telemetry.flush();
    expect(output).toEqual([]);
    expect(existsSync(preferencesPath(configDir))).toBe(false);
    const { properties } = sent.calls[0]!.body.batch[0]!;
    expect(properties['distinct_id']).toBe('ci:github-actions');
    expect(properties['ci']).toBe(true);
    expect(properties['ci_name']).toBe('github-actions');
    // No git and no salt: a runner's working directory is not a project.
    expect(properties['project_id']).toBeNull();
  });

  it('attributes a fleet to its name, writes no preferences, and prints no notice', async () => {
    const { telemetry, output, sent, configDir } = create({ env: { E2E_TELEMETRY_FLEET: 'acme-cloud' } });
    expect(telemetry.enabled).toBe(true);
    telemetry.notice();
    telemetry.session('run', ['--reporter']);
    await telemetry.flush();
    expect(output).toEqual([]);
    expect(existsSync(preferencesPath(configDir))).toBe(false);
    const { properties } = sent.calls[0]!.body.batch[0]!;
    expect(properties['distinct_id']).toBe('fleet:acme-cloud');
    expect(properties['fleet']).toBe('acme-cloud');
    expect(properties['ci']).toBe(false);
    expect(properties['first_run']).toBeNull();
    expect(properties['days_since_first_run']).toBeNull();
    expect(properties['project_id']).toBeNull();
  });

  it('a fleet name wins over a CI vendor and folds when it is not a plain token', async () => {
    const { telemetry, sent } = create({ env: { E2E_TELEMETRY_FLEET: 'runner-7.internal.acme.example/eu', CI: '1', GITHUB_ACTIONS: '1' } });
    telemetry.session('run', []);
    await telemetry.flush();
    const { properties } = sent.calls[0]!.body.batch[0]!;
    expect(properties['distinct_id']).toBe('fleet:other');
    expect(properties['fleet']).toBe('other');
    expect(properties['ci_name']).toBe('github-actions');
  });

  it('reads the fleet name as a plain token and a blank variable as unset', () => {
    expect(fleetName({ E2E_TELEMETRY_FLEET: ' ' })).toBeNull();
    expect(fleetName({ E2E_TELEMETRY_FLEET: 'Cloud_Sandbox.v2' })).toBe('Cloud_Sandbox.v2');
    expect(statedIdentity({ E2E_TELEMETRY_FLEET: 'acme' })).toBe('fleet:acme');
    expect(statedIdentity({ CI: '1' })).toBe('ci:unknown');
    expect(statedIdentity({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe('ci:github-actions');
    // A vendor marker without CI is a shell on a runner, not a run: the machine stays the unit.
    expect(statedIdentity({ GITHUB_ACTIONS: 'true' })).toBeUndefined();
    expect(statedIdentity({})).toBeUndefined();
  });

  it('still honors an opt-out inside a fleet', async () => {
    const { telemetry, sent } = create({ env: { E2E_TELEMETRY_FLEET: 'acme', E2E_TELEMETRY_DISABLED: '1' } });
    expect(telemetry.disabledBy).toBe('E2E_TELEMETRY_DISABLED');
    telemetry.session('run', []);
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
  });

  it('names the sandbox the kernel announces and the runtime the CLI runs under', () => {
    const cwd = tempDir();
    const local = collectEnvironment({ env: {}, cwd, version: '1.2.3' });
    expect(local.runtime).toBe('node');
    expect(local.runtime_version).toBe(process.versions.node);

    const sandboxed = collectEnvironment({
      env: {},
      cwd,
      version: '1.2.3',
      host: { release: '6.18.36-cloudflare-firecracker-2026.6.17', versions: { ...process.versions, bun: '1.3.9', node: '24.20.0' } },
    });
    expect(sandboxed.sandbox).toBe('firecracker');
    expect(sandboxed.runtime).toBe('bun');
    expect(sandboxed.runtime_version).toBe('1.3.9');
    expect(sandboxed.node_version).toBe('24.20.0');
    expect(collectEnvironment({ env: {}, cwd, version: '1.2.3', host: { release: '25.6.0', versions: process.versions } }).sandbox).toBeNull();
  });

  it('names an unclaimed CI and the coding agent driving the shell', async () => {
    const { telemetry, sent } = create({ env: { CI: '1', CLAUDECODE: '1' } });
    telemetry.session('run', []);
    await telemetry.flush();
    const { properties } = sent.calls[0]!.body.batch[0]!;
    expect(properties['distinct_id']).toBe('ci:unknown');
    expect(properties['ci_name']).toBe('unknown');
    expect(properties['coding_agent']).toBe('claude-code');
  });

  it('prints every event under E2E_TELEMETRY_DEBUG and sends nothing', async () => {
    const { telemetry, output, sent } = create({ env: { E2E_TELEMETRY_DEBUG: '1' } });
    expect(telemetry.debug).toBe(true);
    telemetry.session('cache ls', []);
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
    const lines = output.filter((text) => text.startsWith('[telemetry] '));
    expect(lines).toHaveLength(1);
    const printed = JSON.parse(lines[0]!.slice('[telemetry] '.length)) as { event: string; properties: Record<string, unknown> };
    expect(printed.event).toBe(EVENT_CLI_SESSION);
    expect(printed.properties['command']).toBe('cache ls');
  });

  it('gives up at the flush deadline and swallows transport failures', async () => {
    // Like the real fetch, a request on a signal that already fired rejects at
    // once: on a slow machine the project lookup can outlive the 50 ms budget,
    // and the abort event a listener waits for has then already happened.
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const slow = create({ fetch: hanging });
    slow.telemetry.session('run', []);
    const started = Date.now();
    await slow.telemetry.flush(50);
    expect(Date.now() - started).toBeLessThan(1_500);

    const throwing = create({
      fetch: (() => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    throwing.telemetry.session('run', []);
    await expect(throwing.telemetry.flush()).resolves.toBeUndefined();

    const rejected = recordingFetch(500);
    const refused = create({ fetch: rejected.fetch });
    refused.telemetry.session('run', []);
    await expect(refused.telemetry.flush()).resolves.toBeUndefined();
    expect(rejected.calls).toHaveLength(1);
  });

  it('holds the project lookup to the same deadline as the request', async () => {
    const stuck = create({ projectId: () => new Promise<string | undefined>(() => undefined) });
    stuck.telemetry.session('run', []);
    const started = Date.now();
    await stuck.telemetry.flush(50);
    expect(Date.now() - started).toBeLessThan(1_500);
    // The lookup used the whole budget, so the request had none left: a lost batch, not a late command.
    expect(stuck.sent.calls).toEqual([]);

    const prompt = create({ projectId: async () => 'f'.repeat(64) });
    prompt.telemetry.session('run', []);
    await prompt.telemetry.flush();
    expect(prompt.sent.calls[0]!.body.batch[0]!.properties['project_id']).toBe('f'.repeat(64));
  });
});
