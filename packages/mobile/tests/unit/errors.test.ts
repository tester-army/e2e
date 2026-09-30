import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from 'agent-device';
import { EngineError, TestError, type OperationContext, type SemanticNode } from 'e2e/engine';
import { isRunnerFailure, isSnapshotPresentationFailure, staleOr, translateError } from '../../src/errors.ts';
import { SETTINGS_SNAPSHOT } from '../helpers/fake-client.ts';
import { boot, harness, PROJECT_ROOT, type Harness } from '../helpers/harness.ts';
import { noSecrets } from '../helpers/secrets.ts';

describe('error translation', () => {
  it('passes classified errors through untouched', () => {
    const engine = new EngineError('NOT_ACTIONABLE', 'no', { retryable: false });
    expect(translateError(engine, 'perform')).toBe(engine);
    const runner = new TestError('POLICY_DENIED', 'no');
    expect(staleOr(runner, 'perform')).toBe(runner);
  });

  it('maps a missing session to INVALID_STATE and unsupported operations to UNSUPPORTED_CAPABILITY', () => {
    expect(translateError(new AppError('SESSION_NOT_FOUND', 'session gone'), 'snapshot')).toMatchObject({
      code: 'INVALID_STATE',
      retryable: false,
    });
    expect(translateError(new Error('No active app session. Run open first.'), 'snapshot')).toMatchObject({
      code: 'INVALID_STATE',
    });
    // What `appstate` says once `close` ended the session; the harness reports it as APP_NOT_OPEN.
    expect(
      translateError(
        new AppError('INVALID_ARGS', 'appstate requires an active session or an explicit device selector (e.g. --platform ios).'),
        'device.foregroundApp',
      ),
    ).toMatchObject({ code: 'INVALID_STATE', retryable: false });
    expect(
      translateError(
        new AppError('SESSION_NOT_FOUND', 'iOS appstate requires an active session on the target device. Run open first.'),
        'device.foregroundApp',
      ),
    ).toMatchObject({ code: 'INVALID_STATE' });
    expect(translateError(new AppError('UNSUPPORTED_OPERATION', 'hover is macOS only'), 'perform hover')).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    expect(
      translateError(
        new AppError('COMMAND_FAILED', 'Android shell clipboard write is not supported on this device.'),
        'device.setClipboard',
      ),
    ).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('keeps a timeout the device reports under ENGINE_FAILURE with its text and hint, never OPERATION_TIMEOUT', () => {
    const hint = 'Retry simulator boot and inspect simctl bootstatus logs; in CI reduce parallel jobs or use a larger runner.';
    const bootTimeout = translateError(
      new AppError('IOS_BOOT_TIMEOUT', 'Timed out waiting for iPhone 17 Pro to boot', { hint }),
      'boot',
    );
    expect(bootTimeout).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(bootTimeout.message).toBe(`boot failed: Timed out waiting for iPhone 17 Pro to boot Hint: ${hint}`);
    expect(translateError(new Error('snapshot timed out after 30000ms'), 'snapshot')).toMatchObject({
      code: 'ENGINE_FAILURE',
      message: 'snapshot failed: snapshot timed out after 30000ms',
    });
    expect(
      translateError(new AppError('IOS_RUNNER_CONNECT_TIMEOUT', 'runner connect timed out after 60s'), 'open com.example.app'),
    ).toMatchObject({ code: 'ENGINE_FAILURE', message: 'open com.example.app failed: runner connect timed out after 60s' });
  });

  it('maps stale refs and the rest', () => {
    expect(staleOr(new Error('ref @e12 not found in the current snapshot'), 'perform tap')).toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
    });
    expect(staleOr(new Error('Unknown ref: @e3'), 'perform tap')).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translateError(new Error('ref @e12 not found'), 'observe')).toMatchObject({ code: 'ENGINE_FAILURE' });
    const failure = translateError(new AppError('COMMAND_FAILED', 'xcrun exploded'), 'boot');
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(failure.message).toBe('boot failed: xcrun exploded');
  });

  it('keeps the agent-device hint in the message so the model sees the recovery path', () => {
    const refused = new AppError(
      'UNSUPPORTED_OPERATION',
      'Unable to dismiss the iOS keyboard: the keyboard exposes no dismiss key',
      { hint: 'Tap the app\'s own Done control, or press the return key to submit.' },
    );
    const translated = translateError(refused, 'keyboard.dismiss');
    expect(translated).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(translated.message).toBe(
      "keyboard.dismiss failed: Unable to dismiss the iOS keyboard: the keyboard exposes no dismiss key Hint: Tap the app's own Done control, or press the return key to submit.",
    );
    expect(translateError(new AppError('COMMAND_FAILED', 'plain'), 'boot').message).toBe('boot failed: plain');
  });

  it("drops agent-device's generic CLI advice, which helps neither the model nor the run page", () => {
    const advised = new AppError('COMMAND_FAILED', 'permission setting requires an active app in session', {
      hint: 'Check command arguments and run --help for usage examples.',
    });
    expect(translateError(advised, 'device.setPermission').message).toBe('device.setPermission failed: permission setting requires an active app in session');
  });

  it('turns an AbortError into CANCELLED', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(translateError(abort, 'snapshot')).toMatchObject({ code: 'CANCELLED' });
  });
});

/** `RUNNER_BUSY` as the client receives it: folded under `COMMAND_FAILED`, the wire code in the details. */
function runnerBusy(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The iOS runner is still finishing a previous command that exceeded its execution watchdog (usually an accessibility capture on a heavy or animating screen).',
    {
      runnerErrorCode: 'RUNNER_BUSY',
      retriable: true,
      hint: 'Wait a few seconds and retry. If snapshots keep failing on this screen, use screenshot as visual truth and interact by coordinates, or navigate to another screen.',
    },
  );
}

/** The presentation failure as the client receives it: `COMMAND_FAILED` with the failed check in `reason`. */
function invalidViewport(): AppError {
  return new AppError('COMMAND_FAILED', 'regular iOS snapshot presentation requires a valid viewport', {
    reason: 'invalid-viewport',
    field: 'viewport',
    hint: 'Use snapshot --raw to inspect the acquired iOS tree; regular presentation requires valid viewport evidence.',
  });
}

const RECOVERY =
  'If the next run meets it again, stop the daemon (`npx agent-device daemon stop`) and reboot the simulator (`xcrun simctl shutdown <udid>`, then `boot`).';

describe('automation runner failures', () => {
  it('names a busy runner, the session and device, and the recovery under ENGINE_FAILURE, without the model-facing hint', () => {
    const translated = translateError(runnerBusy(), 'snapshot', 'session e2e-ios-0 on iPhone 17 Pro');
    expect(translated).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(translated.message).toBe(
      'snapshot failed: the iOS automation runner is still finishing a command that overran its watchdog (session e2e-ios-0 on iPhone 17 Pro): ' +
        'The iOS runner is still finishing a previous command that exceeded its execution watchdog (usually an accessibility capture on a heavy or animating screen). ' +
        `The app is fine. Wait a few seconds and rerun. ${RECOVERY}`,
    );
    expect(translated.message).not.toContain('Hint:');
    expect(isRunnerFailure(translated)).toBe(true);
    expect(isSnapshotPresentationFailure(translated)).toBe(false);
  });

  it('names a wedged runner by its top-level code, and a watchdog overrun by its wire code', () => {
    const wedged = translateError(
      new AppError('RUNNER_WEDGED', 'The iOS runner main thread has been stuck in abandoned work for 120 seconds and cannot recover on its own.'),
      'perform tap',
    );
    expect(wedged).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(wedged.message).toBe(
      'perform tap failed: the iOS automation runner is wedged: its main thread is stuck in abandoned work: ' +
        'The iOS runner main thread has been stuck in abandoned work for 120 seconds and cannot recover on its own. ' +
        `The app is fine. agent-device restarts the runner; rerun. ${RECOVERY}`,
    );
    expect(isRunnerFailure(wedged)).toBe(true);
    const overran = translateError(
      new AppError('COMMAND_FAILED', 'snapshot timed out on the runner main thread', { runnerErrorCode: 'MAIN_THREAD_TIMEOUT' }),
      'snapshot',
      'session e2e-ios-0',
    );
    expect(overran).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(overran.message).toContain("the iOS automation runner's main thread overran its watchdog on this command (session e2e-ios-0)");
    expect(overran.message).toContain(`The app is fine. Rerun once it has drained. ${RECOVERY}`);
    expect(isRunnerFailure(overran)).toBe(true);
    expect(isRunnerFailure(translateError(new AppError('COMMAND_FAILED', 'xcrun exploded'), 'boot'))).toBe(false);
  });

  it('names a snapshot the runner could not present, by the failed check or the upstream code', () => {
    const byReason = translateError(invalidViewport(), 'snapshot', 'session e2e-ios-0 on iPhone 17 Pro');
    expect(byReason).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(byReason.message).toBe(
      'snapshot failed: the iOS automation runner could not present the accessibility snapshot (session e2e-ios-0 on iPhone 17 Pro): ' +
        `regular iOS snapshot presentation requires a valid viewport The app is fine. Rerun. ${RECOVERY}`,
    );
    expect(isSnapshotPresentationFailure(byReason)).toBe(true);
    expect(isRunnerFailure(byReason)).toBe(false);
    const byCode = translateError(
      new AppError('IOS_SNAPSHOT_ENGINE_FAILED', 'iOS snapshot graph contains an invalid node depth'),
      'snapshot',
    );
    expect(byCode.message).toContain('could not present the accessibility snapshot: iOS snapshot graph contains an invalid node depth');
    expect(isSnapshotPresentationFailure(byCode)).toBe(true);
    expect(isSnapshotPresentationFailure(translateError(new AppError('COMMAND_FAILED', 'plain'), 'snapshot'))).toBe(false);
  });

  it('recognizes every presentation check agent-device raises or rewraps, by reason alone', () => {
    // The text of each is agent-device's; the reason is what the engine reads.
    const raised: readonly [reason: string, text: string][] = [
      ['invalid-viewport', 'regular iOS snapshot presentation requires a valid viewport'],
      ['missing-viewport', 'regular iOS snapshot presentation requires a viewport'],
      ['malformed-graph', 'iOS snapshot graph contains an invalid node depth'],
      ['invalid-presented-payload', 'regular iOS snapshot payload refers to a parent outside the payload'],
      ['invalid-presented-payload', 'regular iOS snapshot payload marked a disabled or off-viewport node actionable'],
      ['invalid-quality-payload', 'iOS snapshot graph contains an invalid node depth'],
    ];
    for (const [reason, text] of raised) {
      const translated = translateError(new AppError('COMMAND_FAILED', text, { reason }), 'snapshot', 'session e2e-ios-0');
      expect(translated, reason).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(translated.message, reason).toBe(
        `snapshot failed: the iOS automation runner could not present the accessibility snapshot (session e2e-ios-0): ${text} The app is fine. Rerun. ${RECOVERY}`,
      );
      expect(isSnapshotPresentationFailure(translated), reason).toBe(true);
    }
    // A reason the presenter does not raise is not a presentation failure: agent-device tags a cancelled capture with one too.
    const cancelledCapture = translateError(new AppError('COMMAND_FAILED', 'snapshot cancelled', { reason: 'request_canceled' }), 'snapshot');
    expect(cancelledCapture.message).toBe('snapshot failed: snapshot cancelled');
    expect(isSnapshotPresentationFailure(cancelledCapture)).toBe(false);
  });
});

describe('automation runner failures through the engine', () => {
  let artifactsDir: string | undefined;

  afterEach(() => {
    if (artifactsDir !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
    artifactsDir = undefined;
  });

  function prepareInfo(lines: string[]) {
    return {
      runId: 'run-1',
      targetName: 'ios',
      projectRoot: PROJECT_ROOT,
      slots: 1,
      env: {},
      signal: new AbortController().signal,
      log: (line: string) => lines.push(line),
    };
  }

  function operation(): OperationContext {
    return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1', origin: 'agent' };
  }

  async function openAttempt(h: Harness): Promise<void> {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-errors-'));
    await boot(h, 'ios');
    await h.engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets });
  }

  /** Every node under the root, the root excluded. */
  function* walk(root: SemanticNode): Generator<SemanticNode> {
    for (const node of root.children ?? []) {
      yield node;
      yield* walk(node);
    }
  }

  it('fails prepare when the runner is busy at warm-up, with the session and device in the message; any other open failure is still logged', async () => {
    const h = harness({ device: 'iPhone 17 Pro' });
    h.fake.respond('apps.open', () => {
      throw runnerBusy();
    });
    const lines: string[] = [];
    await expect(h.prepare(prepareInfo(lines))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining(
        'open Settings failed: the iOS automation runner is still finishing a command that overran its watchdog (session e2e-ios-0 on iPhone 17 Pro)',
      ),
    });
    await expect(h.prepare(prepareInfo(lines))).rejects.toMatchObject({
      message: expect.stringContaining('npx agent-device daemon stop'),
    });
    expect(lines).toEqual(['booting iPhone 17 Pro (1 of 1)', 'booting iPhone 17 Pro (1 of 1)']);

    h.fake.respond('apps.open', () => {
      throw new Error('runner still installing');
    });
    await h.prepare(prepareInfo(lines));
    expect(lines[3]).toMatch(/Settings did not open.*runner still installing/);
  });

  it('closes every session a failed warm-up opened at finish, and still releases the leases when a close fails', async () => {
    const released: string[] = [];
    const cloud = {
      name: 'toy-cloud',
      acquire: async (request: { slot: number }) => ({
        id: `lease-${request.slot}`,
        daemon: { baseUrl: `https://${request.slot}.example` },
        device: `sim-${request.slot}`,
      }),
      release: async (lease: { id: string }) => {
        released.push(lease.id);
      },
    };
    const h = harness({ device: cloud });
    h.fake.respond('apps.open', (args) => {
      if ((args as { device?: string }).device === 'sim-1') throw runnerBusy();
      return {};
    });
    const closes = () => h.fake.methods().filter((method) => method === 'sessions.close').length;
    const info = { ...prepareInfo([]), slots: 2 };
    await expect(h.prepare(info)).rejects.toMatchObject({
      message: expect.stringContaining('(session e2e-ios-1 on sim-1)'),
    });
    expect(h.sessions).toEqual(['e2e-ios-0', 'e2e-ios-1']);
    expect(closes()).toBe(0);

    h.fake.respond('sessions.close', () => {
      throw new Error('daemon gone');
    });
    const finish = { ...info, timeoutMs: 5_000 };
    await h.engine.finish!(finish);
    expect(closes()).toBe(2);
    expect(released).toEqual(['lease-0', 'lease-1']);
    // Nothing left: a second finish closes and releases nothing.
    await h.engine.finish!(finish);
    expect(closes()).toBe(2);
    expect(released).toHaveLength(2);
  });

  it('closes the sessions a local pool warmed too, a boot that failed included', async () => {
    const h = harness({ device: ['iPhone 17', 'iPhone 17 Pro'] });
    h.fake.respond('devices.boot', (args) => {
      if ((args as { device?: string }).device === 'iPhone 17 Pro') throw new AppError('DEVICE_NOT_FOUND', 'no such device');
      return {};
    });
    const info = { ...prepareInfo([]), slots: 2 };
    await expect(h.prepare(info)).rejects.toMatchObject({ message: 'boot failed: no such device' });
    await h.engine.finish!({ ...info, timeoutMs: 5_000 });
    expect(h.fake.methods().filter((method) => method === 'sessions.close')).toHaveLength(2);
  });

  it('fails prepare when the runner is wedged at warm-up', async () => {
    const h = harness({ device: 'iPhone 17 Pro' });
    h.fake.respond('apps.open', () => {
      throw new AppError('RUNNER_WEDGED', 'The iOS runner main thread has been stuck in abandoned work for 120 seconds and cannot recover on its own.');
    });
    await expect(h.prepare(prepareInfo([]))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('the iOS automation runner is wedged'),
    });
  });

  it('takes a snapshot the runner could not present once more, and fails the observation on the second failure', async () => {
    const h = harness({ device: 'iPhone 17 Pro' });
    let failures = 1;
    h.fake.respond('capture.snapshot', () => {
      if (failures > 0) {
        failures -= 1;
        throw invalidViewport();
      }
      return SETTINGS_SNAPSHOT;
    });
    await openAttempt(h);
    const snapshot = await h.engine.observe!(operation());
    expect(snapshot.root.children?.length).toBeGreaterThan(0);
    expect(h.fake.methods().filter((method) => method === 'capture.snapshot')).toHaveLength(2);

    failures = 2;
    await expect(h.engine.observe!(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining(
        'snapshot failed: the iOS automation runner could not present the accessibility snapshot (session e2e-ios-0 on iPhone 17 Pro)',
      ),
    });
    expect(h.fake.methods().filter((method) => method === 'capture.snapshot')).toHaveLength(4);
  });

  it('names the session and device when a node action or the screen scroll meets a busy runner', async () => {
    const h = harness({ device: 'iPhone 17 Pro' });
    await openAttempt(h);
    const screen = await h.engine.observe!(operation());
    const about = [...walk(screen.root)].find((node) => node.name === 'About');
    if (about === undefined) throw new Error('no About node');
    h.fake.respond('interactions.press', () => {
      throw runnerBusy();
    });
    await expect(h.engine.perform!(about.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      retryable: false,
      message: expect.stringContaining(
        'perform tap failed: the iOS automation runner is still finishing a command that overran its watchdog (session e2e-ios-0 on iPhone 17 Pro)',
      ),
    });
    h.fake.respond('interactions.scroll', () => {
      throw runnerBusy();
    });
    await expect(h.engine.perform!(screen.root.ref, { kind: 'swipe', direction: 'down' }, operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining(
        'swipe failed: the iOS automation runner is still finishing a command that overran its watchdog (session e2e-ios-0 on iPhone 17 Pro)',
      ),
    });
  });

  it('does not retake a snapshot that failed for any other reason', async () => {
    const h = harness();
    h.fake.respond('capture.snapshot', () => {
      throw runnerBusy();
    });
    await openAttempt(h);
    await expect(h.engine.observe!(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('the iOS automation runner is still finishing a command that overran its watchdog (session e2e-ios-0)'),
    });
    expect(h.fake.methods().filter((method) => method === 'capture.snapshot')).toHaveLength(1);
  });
});
