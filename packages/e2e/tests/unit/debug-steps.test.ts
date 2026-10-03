/** The `--debug` agent step table: one row per agent step, a `via` column only when the steps named several models. */

import { describe, expect, it } from 'vitest';
import type { ResolvedTarget } from '../../src/config/resolve.ts';
import { agentStepTable } from '../../src/report/debug-steps.ts';
import { stepModelLabel } from '../../src/report/format.ts';
import type { AttemptRecord, ResultRecord, SerialGroupRecord, SerialMemberRecord } from '../../src/run/records.ts';
import type { StepModelInfo, StepRecord } from '../../src/run/steps.ts';

const AT = '2026-01-01T00:00:00.000Z';

const target = { name: 'web', index: 0, platform: 'web' } as unknown as ResolvedTarget;

function model(provider: string, id: string, calls: number): StepModelInfo {
  return {
    provider,
    model: id,
    endpoint: 'provider-default',
    adapterVersion: 'executor/default@0',
    policyVersion: 'default/0',
    calls,
    tokenAccounting: 'provider',
    peakTokensPerCall: 100,
    inputTokens: 100 * calls,
    outputTokens: 10 * calls,
  };
}

function step(id: string, label: string, overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    id,
    index: 0,
    kind: 'agent',
    api: 'agent.act',
    label,
    status: 'passed',
    startedAt: AT,
    durationMs: 1200,
    events: [],
    artifacts: [],
    ...overrides,
  } as StepRecord;
}

function attempt(steps: StepRecord[]): AttemptRecord {
  return { id: 'attempt-1', index: 0, status: 'passed', startedAt: AT, durationMs: 1500, steps, artifacts: [], secondaryErrors: [], cleanup: 'complete' };
}

function result(title: string, steps: StepRecord[]): ResultRecord {
  return {
    test: {
      kind: 'test',
      title,
      titlePath: [title],
      declarationIndex: 0,
      sessions: [],
      tags: [],
      source: undefined,
      file: 'tests/case.e2e.ts',
      id: `tests/case.e2e.ts::${title}`,
      serialId: undefined,
    },
    target,
    agent: 'default',
    repeat: 0,
    status: 'passed',
    selected: true,
    attempts: [attempt(steps)],
  };
}

function serialGroup(members: SerialMemberRecord[]): SerialGroupRecord {
  return {
    id: 'g1',
    serialId: 'wizard',
    declarationIndex: 0,
    file: 'tests/wizard.e2e.ts',
    titlePath: ['wizard'],
    targetId: 'web',
    platform: 'web',
    agent: 'default',
    repeat: 0,
    memberTestIds: members.map((each) => each.testId),
    status: 'passed',
    attempts: [{ id: 'g1-attempt-1', index: 0, status: 'passed', startedAt: AT, durationMs: 3000, members, artifacts: [], secondaryErrors: [], cleanup: 'complete' }],
  };
}

function member(testId: string, steps: StepRecord[]): SerialMemberRecord {
  return { id: `${testId}-member`, index: 0, testId, status: 'passed', startedAt: AT, durationMs: 1500, steps, secondaryErrors: [] };
}

/** Header cells and the rows' cells, split on the table's two-space gutter. */
function cells(table: string): string[][] {
  return table.trimEnd().split('\n').slice(1).map((line) => line.trim().split(/\s{2,}/));
}

describe('agentStepTable', () => {
  it('adds a via column labelled through the shared helper when the steps named several models, serial members included', () => {
    const acted = model('typesafe-ai', 'jev', 2);
    const judged = model('fake-loop', 'scripted-loop', 1);
    const table = agentStepTable(
      [result('pays', [step('s1', 'pay', { model: acted }), step('s2', 'no model call')])],
      [serialGroup([member('m1', [step('s3', 'confirm', { api: 'agent.assert', model: judged })])])],
    );
    expect(table).toMatch(/^\[e2e debug\] agent steps \(execution order\)\n/);
    const [header, ...rows] = cells(table);
    expect(header).toEqual(['step', 'via', 'total', 'model', 'observe', 'action', 'calls', 'tokens in/out', 'cached', 'cost']);
    expect(rows.map((row) => row.slice(0, 2))).toEqual([
      ['agent.act "pay"', stepModelLabel(acted)],
      ['agent.act "no model call"', '-'],
      ['agent.assert "confirm"', stepModelLabel(judged)],
    ]);
    expect(stepModelLabel(acted)).toBe('typesafe-ai/jev');
  });

  it('shows `-` for a step whose model record lacks provenance and never prints undefined', () => {
    const table = agentStepTable(
      [result('pays', [
        step('s1', 'pay', { model: model('typesafe-ai', 'jev', 2) }),
        step('s2', 'judge', { model: { calls: 1, inputTokens: 100, outputTokens: 10 } as StepModelInfo }),
        step('s3', 'confirm', { model: model('fake-loop', 'scripted-loop', 1) }),
      ])],
      [],
    );
    const [, ...rows] = cells(table);
    expect(rows.map((row) => row[1])).toEqual(['typesafe-ai/jev', '-', 'fake-loop/scripted-loop']);
    expect(table).not.toContain('undefined');
  });
});
