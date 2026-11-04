/**
 * What a serial group attempt records about its retry: the decision to cut it
 * is on the record before it streams, and the report reads it back.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CollectedTest } from '../../src/collect/collect.ts';
import type { ResolvedTestOptions, TestTargetPair } from '../../src/collect/select.ts';
import type { ResolvedTarget } from '../../src/config/resolve.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { classifyError, serializeError } from '../../src/internal/errors.ts';
import { buildReport } from '../../src/report/build.ts';
import { outcome } from '../../src/report/outcome.ts';
import { RealmManager } from '../../src/run/realm.ts';
import type { AttemptRecord, ResultRecord, SerialAttemptRecord, SerialGroupRecord } from '../../src/run/records.ts';
import { runSerialUnit, type SerialHost } from '../../src/run/serial.ts';

const OPTIONS: ResolvedTestOptions = {
  timeout: 30_000,
  retries: 0,
  platforms: undefined,
  requires: [],
  session: undefined,
  agents: ['default'],
  agentContext: undefined,
  skipReason: undefined,
  serial: false,
  trace: undefined,
  video: undefined,
};

const FAILED_ATTEMPT: AttemptRecord = {
  id: 'attempt-0',
  index: 0,
  status: 'failed',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 5,
  steps: [],
  artifacts: [],
  error: serializeError(classifyError(new Error('first attempt fails'))),
  secondaryErrors: [],
  cleanup: 'complete',
};

function makeTarget(name: string, index: number): ResolvedTarget {
  return {
    name,
    index,
    platform: 'web',
    engine: undefined,
    app: {
      base: undefined,
      portRequest: undefined,
      site: undefined,
      environment: 'test',
      identity: undefined,
      bundleId: undefined,
      appPath: undefined,
      launchArguments: undefined,
      permissions: undefined,
      command: undefined,
      readyUrl: undefined,
    },
    declaredApp: {
      url: undefined,
      bundleId: undefined,
      appPath: undefined,
      identity: undefined,
      environment: undefined,
      launchArguments: undefined,
      permissions: undefined,
      command: undefined,
      readyUrl: undefined,
    },
    trace: { mode: 'off', source: 'default' },
    video: { mode: 'off', source: 'default' },
  };
}

/** Two members of one serial group in `tests/a.e2e.ts`. */
function serialPairs(target: ResolvedTarget): TestTargetPair[] {
  return ['step 1', 'step 2'].map((title, declarationIndex) => {
    const file = 'tests/a.e2e.ts';
    const test: CollectedTest = {
      kind: 'test',
      title,
      titlePath: [title],
      declarationIndex,
      options: {},
      sessions: [],
      tags: [],
      fn: () => undefined,
      fixtures: [],
      group: undefined,
      mode: 'normal',
      source: undefined,
      file,
      id: `${file}::${title}`,
      serialRoot: undefined,
      serialId: `${file}::wizard`,
      selected: true,
    };
    return { test, target, agent: 'default', repeat: 0, options: OPTIONS, disposition: 'run', skip: undefined };
  });
}

describe('serial attempt record provenance', () => {
  it.each(['collection', 'launch', 'interrupted', 'reached'] as const)('streams the cut decision before extraction for %s retries', async (mode) => {
    const target = makeTarget('web', 0);
    const pairs = serialPairs(target).slice(0, 1).map((pair) => ({ ...pair, options: { ...pair.options, retries: 1 } }));
    const file = { file: pairs[0]!.test.file, absolutePath: `/project/${pairs[0]!.test.file}` };
    const realms = new RealmManager({ targetName: target.name, platform: target.platform, timeout: 1000, cleanupTimeout: 1000, runErrors: [], redactTitle: (title) => title });
    const controller = new AbortController();
    let created = 0;
    vi.spyOn(realms, 'create').mockImplementation(async () => {
      created += 1;
      if (created === 2 && mode === 'collection') throw new Error('retry collection failed');
      return realms.adopt({ tests: pairs.map((pair) => pair.test), hooks: [] }, file);
    });
    const streamed: SerialAttemptRecord[] = [];
    const groups: SerialGroupRecord[] = [];
    const results: ResultRecord[] = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-serial-record-'));
    const host: SerialHost = {
      target,
      artifactsRoot: dir,
      rerunDir: undefined,
      runId: '018f0f5c-7b2a-7abc-8abc-0123456789ab',
      artifactStore: undefined,
      interruptSignal: controller.signal,
      realms,
      launchSession: async () => {
        if (created === 2 && mode === 'launch') throw new Error('retry launch failed');
        return createEngineSession({ engine: undefined, targetName: target.name });
      },
      closeSession: async () => {},
      runAttempt: async (_pair, _registered, _realm, index) => {
        if (index === 1 && mode === 'interrupted') controller.abort();
        return { ...structuredClone(FAILED_ATTEMPT), index, durationMs: index === 0 ? 1250 : 0 };
      },
      emit: (result) => results.push(result),
      pairStarted: () => {},
      emitSerialGroup: (group) => groups.push(structuredClone(group)),
      serialMemberFinished: () => {},
      serialAttemptFinished: (_groupId, attempt) => {
        expect(attempt.cutRetry).toBe(attempt.index > 0 && mode !== 'reached');
        streamed.push(structuredClone(attempt));
        Object.freeze(attempt);
      },
    };
    try {
      await runSerialUnit(host, pairs, file);
      expect(streamed.map((attempt) => attempt.cutRetry)).toEqual([false, mode !== 'reached']);
      const report = buildReport({ runId: host.runId, config: undefined, startedAt: '2026-01-01T00:00:00.000Z', status: 'failed', exitCode: 1, results, serialGroups: groups, runErrors: [], targetProvenance: new Map() });
      const serialized = JSON.parse(JSON.stringify(report));
      expect(serialized.run.serialGroups[0].attempts.map((attempt: { cutRetry: boolean }) => attempt.cutRetry)).toEqual([false, mode !== 'reached']);
      const result = outcome(report.run.results[0]!, new Map(report.run.serialGroups!.map((group) => [group.id, group])));
      expect(result.durationMs).toBe(mode === 'reached' ? 0 : 1250);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
