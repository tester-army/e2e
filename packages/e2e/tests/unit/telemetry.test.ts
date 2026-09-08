import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cliSessionEvent,
  EVENT_CLI_SESSION,
  EVENT_RUN_COMPLETED,
  runCompletedEvent,
} from '../../src/telemetry/events.ts';
import { preferencesPath, TelemetryStore, telemetryConfigDir } from '../../src/telemetry/store.ts';
import {
  NOTICE_VERSION,
  Telemetry,
  type TelemetryOptions,
} from '../../src/telemetry/telemetry.ts';
import { SAMPLE_REPORT_SECRETS, sampleReport } from '../helpers/sample-report.ts';

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

/** A fetch that records every request and answers with `status`. */
function recordingFetch(status = 200): { calls: SentBatch[]; fetch: typeof fetch } {
  const calls: SentBatch[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
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
    destination: { host: 'https://telemetry.test', apiKey: 'phc_test' },
    fetch: sent.fetch,
    write: (text) => void output.push(text),
    ...overrides,
  });
  return { telemetry, output, sent, configDir };
}

describe('telemetry store', () => {
  it('creates the file on open and keeps the generated id and salt across opens', () => {
    const dir = tempDir();
    const store = TelemetryStore.open(dir);
    expect(store).toBeDefined();
    expect(existsSync(preferencesPath(dir))).toBe(true);
    expect(store!.enabled).toBe(true);
    const id = store!.anonymousId;
    const salt = store!.pathSalt;
    expect(id).toMatch(/^[a-f0-9]{32}$/u);
    expect(salt).toMatch(/^[a-f0-9]{32}$/u);
    expect(id).not.toBe(salt);

    const reopened = TelemetryStore.open(dir)!;
    expect(reopened.anonymousId).toBe(id);
    expect(reopened.pathSalt).toBe(salt);
    expect(reopened.saveEnabled(false)).toBe(true);
    expect(TelemetryStore.open(dir)!.enabled).toBe(false);
  });

  it('starts over from a file that is not JSON', () => {
    const dir = tempDir();
    writeFileSync(preferencesPath(dir), '{not json');
    const store = TelemetryStore.open(dir)!;
    expect(store.enabled).toBe(true);
    expect(JSON.parse(readFileSync(preferencesPath(dir), 'utf8'))).toEqual({});
  });

  it('drops fields it does not know or that have the wrong shape', () => {
    const dir = tempDir();
    writeFileSync(
      preferencesPath(dir),
      JSON.stringify({ enabled: 'yes', anonymousId: 'not hex', salt: 42, notifiedAt: 5, extra: true }),
    );
    const store = TelemetryStore.open(dir)!;
    expect(store.enabled).toBe(true);
    expect(store.wasNotified(NOTICE_VERSION)).toBe(false);
    expect(store.anonymousId).toMatch(/^[a-f0-9]{32}$/u);
    expect(JSON.parse(readFileSync(preferencesPath(dir), 'utf8'))).not.toHaveProperty('extra');
  });

  it('is absent when the directory cannot be created', () => {
    expect(TelemetryStore.open(unwritableDir())).toBeUndefined();
  });

  it('remembers the notice per version', () => {
    const store = TelemetryStore.open(tempDir())!;
    expect(store.wasNotified(1)).toBe(false);
    store.markNotified(1, '2026-09-08T10:00:00.000Z');
    expect(store.wasNotified(1)).toBe(true);
    expect(store.wasNotified(2)).toBe(false);
  });

  it('resolves the config directory from XDG_CONFIG_HOME, the home directory, or APPDATA', () => {
    expect(telemetryConfigDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe(path.join('/xdg', 'e2e'));
    expect(telemetryConfigDir({ XDG_CONFIG_HOME: '  ' }, 'darwin')).toBe(path.join(os.homedir(), '.config', 'e2e'));
    expect(telemetryConfigDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32')).toBe(
      path.join('C:\\Users\\me\\AppData\\Roaming', 'e2e'),
    );
  });
});

describe('Telemetry', () => {
  it('is on by default, prints the notice once, and sends one batch with identity and environment', async () => {
    const { telemetry, output, sent, configDir } = create();
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.disabledBy).toBeUndefined();
    expect(telemetry.configured).toBe(true);

    telemetry.notice();
    telemetry.notice();
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('e2e collects anonymous usage telemetry');
    expect(output[0]).toContain('e2e telemetry disable');
    expect(output[0]).toContain('E2E_TELEMETRY_DISABLED=1');
    expect(output[0]).toContain('/telemetry');
    expect(TelemetryStore.open(configDir)!.wasNotified(NOTICE_VERSION)).toBe(true);

    telemetry.record(cliSessionEvent('run', ['--headed']));
    await telemetry.flush();

    expect(sent.calls).toHaveLength(1);
    const [call] = sent.calls;
    expect(call!.url).toBe('https://telemetry.test/batch/');
    expect(call!.body.api_key).toBe('phc_test');
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
    expect(properties['ci']).toBe(false);
    expect(properties['ci_name']).toBeNull();
    expect(properties['coding_agent']).toBeNull();
    expect(properties['os']).toBe(os.platform());
    expect(properties['arch']).toBe(os.arch());
    expect(properties['node_version']).toBe(process.versions.node);
    expect(typeof properties['cpu_count']).toBe('number');
    expect(typeof properties['memory_gb']).toBe('number');
    expect(typeof properties['package_manager']).toBe('string');
  });

  it('batches every event of an invocation into one request and then has nothing left', async () => {
    const { telemetry, sent } = create();
    telemetry.record(cliSessionEvent('run', []));
    telemetry.record(runCompletedEvent(sampleReport(), []));
    await telemetry.flush();
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]!.body.batch.map((item) => item.event)).toEqual([EVENT_CLI_SESSION, EVENT_RUN_COMPLETED]);
    // The run event is stamped with the report's own finish time.
    expect(sent.calls[0]!.body.batch[1]!.timestamp).toBe('2026-09-08T10:00:05.000Z');

    await telemetry.flush();
    expect(sent.calls).toHaveLength(1);
  });

  it('keeps the same project id across invocations on one machine and differs across machines', async () => {
    const cwd = tempDir();
    const configDir = tempDir();
    const first = create({ cwd, configDir });
    first.telemetry.record(cliSessionEvent('list', []));
    await first.telemetry.flush();
    const second = create({ cwd, configDir });
    second.telemetry.record(cliSessionEvent('list', []));
    await second.telemetry.flush();
    const other = create({ cwd });
    other.telemetry.record(cliSessionEvent('list', []));
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
    telemetry.record(cliSessionEvent('run', []));
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
    second.telemetry.record(cliSessionEvent('run', []));
    await second.telemetry.flush();
    expect(second.output).toEqual([]);
    expect(second.sent.calls).toEqual([]);

    expect(second.telemetry.setEnabled(true)).toBe(preferencesPath(configDir));
    expect(second.telemetry.disabledBy).toBeUndefined();
  });

  it('drops an event recorded before the opt-out landed', async () => {
    const { telemetry, sent } = create();
    telemetry.record(cliSessionEvent('telemetry', []));
    telemetry.setEnabled(false);
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
  });

  it('treats an unwritable preferences directory as off', async () => {
    const { telemetry, output, sent } = create({ configDir: unwritableDir() });
    expect(telemetry.disabledBy).toBe('store');
    expect(telemetry.setEnabled(true)).toBeUndefined();
    telemetry.notice();
    telemetry.record(cliSessionEvent('run', []));
    await telemetry.flush();
    expect(output).toEqual([]);
    expect(sent.calls).toEqual([]);
  });

  it('attributes CI runs to the vendor, writes no preferences, and prints no notice', async () => {
    const { telemetry, output, sent, configDir } = create({ env: { CI: 'true', GITHUB_ACTIONS: 'true' } });
    telemetry.notice();
    telemetry.record(cliSessionEvent('run', ['--reporter']));
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

  it('names an unclaimed CI and the coding agent driving the shell', async () => {
    const { telemetry, sent } = create({ env: { CI: '1', CLAUDECODE: '1' } });
    telemetry.record(cliSessionEvent('run', []));
    await telemetry.flush();
    const { properties } = sent.calls[0]!.body.batch[0]!;
    expect(properties['distinct_id']).toBe('ci:unknown');
    expect(properties['ci_name']).toBe('unknown');
    expect(properties['coding_agent']).toBe('claude-code');
  });

  it('prints every event under E2E_TELEMETRY_DEBUG and sends nothing', async () => {
    const { telemetry, output, sent } = create({ env: { E2E_TELEMETRY_DEBUG: '1' } });
    expect(telemetry.debug).toBe(true);
    telemetry.record(cliSessionEvent('cache ls', []));
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
    const lines = output.filter((text) => text.startsWith('[telemetry] '));
    expect(lines).toHaveLength(1);
    const printed = JSON.parse(lines[0]!.slice('[telemetry] '.length)) as { event: string; properties: Record<string, unknown> };
    expect(printed.event).toBe(EVENT_CLI_SESSION);
    expect(printed.properties['command']).toBe('cache ls');
  });

  it('sends nothing when the build has no destination key', async () => {
    const { telemetry, sent } = create({ destination: { host: 'https://telemetry.test', apiKey: '' } });
    expect(telemetry.configured).toBe(false);
    expect(telemetry.enabled).toBe(true);
    telemetry.record(cliSessionEvent('run', []));
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
  });

  it('gives up at the flush deadline and swallows transport failures', async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const slow = create({ fetch: hanging });
    slow.telemetry.record(cliSessionEvent('run', []));
    const started = Date.now();
    await slow.telemetry.flush(50);
    expect(Date.now() - started).toBeLessThan(1_500);

    const throwing = create({
      fetch: (() => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    throwing.telemetry.record(cliSessionEvent('run', []));
    await expect(throwing.telemetry.flush()).resolves.toBeUndefined();

    const rejected = recordingFetch(500);
    const refused = create({ fetch: rejected.fetch });
    refused.telemetry.record(cliSessionEvent('run', []));
    await expect(refused.telemetry.flush()).resolves.toBeUndefined();
    expect(rejected.calls).toHaveLength(1);
  });
});

describe('telemetry events', () => {
  it('the session event carries the command and the flag names only', () => {
    expect(cliSessionEvent('cache ls', ['--config'])).toEqual({
      name: EVENT_CLI_SESSION,
      properties: { command: 'cache ls', flags: ['--config'] },
    });
  });

  it("the run event is the report's numbers, with project vocabulary folded", () => {
    const event = runCompletedEvent(sampleReport(), ['--headed', '--workers']);
    expect(event.name).toBe(EVENT_RUN_COMPLETED);
    expect(event.at).toBe('2026-09-08T10:00:05.000Z');
    expect(event.properties).toEqual({
      status: 'failed',
      exit_code: 1,
      duration_ms: 5000,
      flags: ['--headed', '--workers'],
      tests_discovered: 3,
      tests_selected: 2,
      tests_executed: 2,
      tests_passed: 1,
      tests_failed: 1,
      tests_flaky: 0,
      tests_skipped: 1,
      targets: 2,
      platforms: ['other', 'web'],
      engines: ['other', 'playwright@0.6.1'],
      steps_total: 5,
      steps_agent: 2,
      steps_locator: 1,
      steps_assertion: 1,
      steps_screen: 1,
      steps_app: 0,
      steps_session: 0,
      steps_resource: 0,
      agent_steps_replayed: 1,
      agent_steps_partial: 0,
      agent_steps_missed: 1,
      agent_steps_vision: 1,
      model_provider: 'anthropic',
      model_id: 'claude-sonnet-4-5',
      model_calls: 4,
      model_tokens: 2850,
      estimated_cost_usd: 0.01,
      artifact_bytes: 4096,
      errors: 1,
      error_codes: ['APP_UNREACHABLE', 'LOCATOR_NOT_FOUND', 'OTHER'],
    });
  });

  it('folds a fine-tuned or routed model id into other', () => {
    const report = sampleReport();
    const [first] = report.run.results[0]!.attempts[0]!.steps;
    (first as { model: { model: string } }).model.model = 'accounts/acme/models/custom';
    expect(runCompletedEvent(report, []).properties['model_id']).toBe('other');
  });

  it('copies no title, file, origin, engine name, or message out of the report', () => {
    const payload = JSON.stringify(runCompletedEvent(sampleReport(), ['--headed']));
    for (const secret of SAMPLE_REPORT_SECRETS) expect(payload).not.toContain(secret);
  });

  it('reports a missing duration as null rather than a negative or NaN number', () => {
    const report = sampleReport();
    (report.run as { finishedAt: string }).finishedAt = 'not a date';
    expect(runCompletedEvent(report, []).properties['duration_ms']).toBeNull();
  });
});
