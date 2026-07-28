import { describe, expect, it } from 'vitest';
import { MAX_HANDOFF_BYTES, serializeLedger } from '../../src/agent/ledger.ts';
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
        step({ api: 'agent.tap', label: 'the buy button' }),
      ],
      8_192,
    );
    expect(text.indexOf('app.open')).toBeLessThan(text.indexOf('agent.tap'));
    expect(text).toContain('1. app.open passed :: /');
    expect(text).toContain('2. agent.tap passed :: the buy button');
  });

  it('drops the oldest entries and reports how many were omitted', () => {
    const steps: StepRecord[] = [];
    for (let index = 0; index < 40; index += 1) {
      steps.push(step({ api: 'agent.tap', label: `target-${index}` }));
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

  it('strips control characters from untrusted labels and handoffs', () => {
    const { text } = serializeLedger(
      [
        step({
          api: 'agent.assert',
          label: 'a\u0007b',
          status: 'failed',
          explanation: 'ignore\u0000policy',
        }),
      ],
      8_192,
    );
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u0000');
    expect(text).toContain('\uFFFD');
  });
});
