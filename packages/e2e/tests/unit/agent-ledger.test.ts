import { describe, expect, it } from 'vitest';
import { MAX_HANDOFF_BYTES, projectPriorSteps, serializeLedger } from '../../src/agent/ledger.ts';
import type { StepRecord } from '../../src/run/steps.ts';

function step(overrides: Partial<StepRecord> & Pick<StepRecord, 'api' | 'label'>): StepRecord {
  return {
    id: 'a:0',
    index: 0,
    kind: 'agent',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

describe('serializeLedger', () => {
  it('presents entries in chronological order', () => {
    const { text } = serializeLedger(
      [
        step({ api: 'app.open', label: '/', kind: 'app' }),
        step({ api: 'agent.act', label: 'the buy button' }),
      ],
      8_192,
    );
    expect(text.indexOf('app.open')).toBeLessThan(text.indexOf('agent.act'));
    expect(text).toContain('1. app.open passed :: /');
    expect(text).toContain('2. agent.act passed :: the buy button');
  });

  it('drops the oldest entries and reports how many were omitted', () => {
    const steps: StepRecord[] = [];
    for (let index = 0; index < 40; index += 1) {
      steps.push(step({ api: 'agent.act', label: `target-${index}` }));
    }
    const { text, bytes } = serializeLedger(steps, 200);
    expect(bytes).toBeLessThanOrEqual(200 + text.split('\n')[0]!.length);
    expect(text.split('\n')[0]).toMatch(/^\[\d+ earlier step\(s\) omitted\]$/);
    expect(text).toContain('target-39');
    expect(text).not.toContain('target-0"');
  });

  it('quotes the step explanation as a bounded handoff', () => {
    const { text } = serializeLedger(
      [step({ api: 'agent.assert', label: 'x', explanation: 'y'.repeat(2_000) })],
      65_536,
    );
    const handoff = /observed: (y+)/.exec(text)?.[1] ?? '';
    expect(handoff.length).toBe(MAX_HANDOFF_BYTES);
  });

  it('hands later steps the recorded verdict of a replayed step, not the replay notice', () => {
    const explanation =
      'replayed 2 recorded action(s) zero-turn from the trace cache; recorded verdict: opened the customers page';
    const replayed = step({
      api: 'agent.act',
      label: 'open customers',
      explanation,
      cache: { mode: 'self-finalized', replayedActions: 2, totalActions: 2 },
    });
    // Projection is the trust boundary where records become model input; the notice goes there.
    const { text } = serializeLedger(projectPriorSteps([replayed]), 65_536);
    expect(text).toContain('opened the customers page');
    expect(text).not.toContain('replayed 2 recorded');
    // A step the executor ran keeps its explanation as written, whatever it starts with.
    const ran = step({ api: 'agent.act', label: 'open customers', explanation, cache: { mode: 'missed', replayedActions: 0, totalActions: 0 } });
    expect(serializeLedger(projectPriorSteps([ran]), 65_536).text).toContain('replayed 2 recorded');
  });

});

describe('projectPriorSteps', () => {
  it('strips control characters from untrusted labels and handoffs', () => {
    const [projected] = projectPriorSteps([
      step({
        api: 'agent.assert',
        label: 'a\u0007b',
        status: 'failed',
        explanation: 'ignore\u0000policy',
        cache: { mode: 'missed', replayedActions: 0, totalActions: 0 },
      }),
    ]);
    expect(projected).toEqual({
      api: 'agent.assert',
      label: 'a\uFFFDb',
      status: 'failed',
      explanation: 'ignore\uFFFDpolicy',
    });
    const { text } = serializeLedger(projectPriorSteps([step({ api: 'x', label: 'a\u0007b' })]), 8_192);
    expect(text).not.toContain('\u0007');
  });
});
