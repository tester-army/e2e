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
        step({ api: 'agent.act', label: 'the buy button' }),
      ],
      8_192,
    );
    expect(text.indexOf('app.open')).toBeLessThan(text.indexOf('agent.act'));
    expect(text).toContain('1. app.open passed :: /');
    expect(text).toContain('2. agent.act passed :: the buy button');
  });

  it('drops the middle of an overlong ledger, keeping how it started and how it stands', () => {
    const steps: StepRecord[] = [];
    for (let index = 0; index < 40; index += 1) {
      steps.push(step({ api: 'agent.act', label: `target-${index}` }));
    }
    const { text, bytes } = serializeLedger(steps, 200);
    expect(bytes).toBeLessThanOrEqual(200);
    expect(text.startsWith('1. agent.act passed :: target-0\n')).toBe(true);
    expect(text).toContain('target-39');
    expect(text).toMatch(/\n\[steps \d+–\d+ omitted\]\n/);
    expect(text).not.toContain('target-20');
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

describe('serializeLedger action trail', () => {
  it('quotes the recorded actions of a step as a bounded "did" line before the summary', () => {
    const events = [
      { kind: 'observation' as const, startedAt: 't', durationMs: 1, status: 'passed' as const },
      { kind: 'backend' as const, startedAt: 't', durationMs: 1, status: 'passed' as const, name: 'type', detail: 'type "Nimbus Paper Co" into textbox "Supplier name"' },
      { kind: 'backend' as const, startedAt: 't', durationMs: 1, status: 'failed' as const, name: 'tap', detail: 'tap button "Nope"' },
      { kind: 'backend' as const, startedAt: 't', durationMs: 1, status: 'passed' as const, name: 'tap', detail: 'tap button "Add supplier"' },
      { kind: 'model' as const, startedAt: 't', durationMs: 1, status: 'passed' as const, name: 'executor' },
    ];
    const { text } = serializeLedger(
      [step({ api: 'agent.act', label: 'add a supplier', explanation: 'Added the supplier; the table shows it.', events })],
      8_192,
    );
    expect(text).toBe(
      '1. agent.act passed :: add a supplier\n' +
        '   did: type "Nimbus Paper Co" into textbox "Supplier name"; tap button "Add supplier"\n' +
        '   observed: Added the supplier; the table shows it.',
    );
  });

  it('bounds the trail and marks how many actions it left out', () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      kind: 'backend' as const,
      startedAt: 't',
      durationMs: 1,
      status: 'passed' as const,
      name: 'type',
      detail: `type "value number ${index}" into textbox "Field ${index}"`,
    }));
    const { text } = serializeLedger([step({ api: 'agent.act', label: 'fill', events })], 8_192);
    const did = /did: (.*)/.exec(text)![1]!;
    expect(new TextEncoder().encode(did).byteLength).toBeLessThanOrEqual(320);
    expect(did).toMatch(/… \+\d+ more$/);
  });
});

describe('serializeLedger tiers', () => {
  const act = (index: number, extra: Partial<StepRecord> = {}): StepRecord =>
    step({
      api: 'agent.act',
      label: `act ${index}`,
      explanation: `Long prose about act ${index}. `.repeat(8),
      events: [
        { kind: 'backend', startedAt: 't', durationMs: 1, status: 'passed', name: 'tap', detail: `tap button "Do ${index}"` },
      ],
      ...extra,
    });
  const check = (index: number): StepRecord =>
    step({ api: 'expect.toBeVisible', label: `getByText("thing ${index}")`, kind: 'locator' });

  it('keeps the facts of an early step when its prose no longer fits', () => {
    const steps: StepRecord[] = [
      act(1, { handoff: { appeared: ['Ticket TK-6830 · colour Amber · desk 8'], noted: ['TK-6830', 'valid until Friday'] } }),
    ];
    for (let index = 2; index <= 14; index += 1) {
      steps.push(act(index), check(index));
    }
    const { text, bytes } = serializeLedger(steps, 2_048);
    expect(bytes).toBeLessThanOrEqual(2_048);
    expect(text).not.toContain('omitted');
    // The first entry is compact: no prose, but its facts are there.
    // A noted fact the screen already states is not repeated; the rest is.
    expect(text).toContain('1. agent.act passed :: act 1\n   saw: Ticket TK-6830 · colour Amber · desk 8\n   noted: valid until Friday\n');
    expect(text).not.toContain('Long prose about act 1.');
    // The newest entries are full.
    expect(text).toContain('did: tap button "Do 14"');
    expect(text).toContain('observed: Long prose about act 14.');
  });

  it('folds consecutive checks into one line in compact form and counts dropped steps by step', () => {
    const steps: StepRecord[] = [act(1), check(2), check(3), check(4), act(5), check(6)];
    const { text } = serializeLedger(steps, 4_000);
    expect(text).toContain('2–4. 3 checks passed');
    const tiny = serializeLedger(steps, 100);
    expect(tiny.text).toMatch(/^\[\d+ earlier step\(s\) omitted\]/);
    // Dropping the folded line drops three steps, not one.
    const omitted = Number(/^\[(\d+) earlier/.exec(tiny.text)![1]);
    expect(omitted).toBeGreaterThanOrEqual(3);
  });

  it('drops fact-less steps before a fact-bearing early step, marking the gaps', () => {
    const steps: StepRecord[] = [
      act(1, { handoff: { appeared: ['Ticket TK-6830 · colour Amber · desk 8'], noted: ['TK-6830', 'Amber', 'desk 8'] } }),
    ];
    for (let index = 2; index <= 40; index += 1) {
      steps.push(act(index), check(index));
    }
    const { text, bytes } = serializeLedger(steps, 2_048);
    expect(bytes).toBeLessThanOrEqual(2_048);
    expect(text.startsWith('1. agent.act passed :: act 1\n   saw: Ticket TK-6830')).toBe(true);
    expect(text).toMatch(/\n\[steps \d+–\d+ omitted\]\n/);
    expect(text).toContain('did: tap button "Do 40"');
  });

  it('renders saw and noted lines in the full form too', () => {
    const { text } = serializeLedger(
      [act(1, { handoff: { appeared: ['PO-1007 — Nimbus Paper Co — Draft — total $66.69'], noted: ['PO-1007', 'two line items'] } })],
      8_192,
    );
    expect(text).toContain('   did: tap button "Do 1"\n   saw: PO-1007 — Nimbus Paper Co — Draft — total $66.69\n   noted: two line items\n   observed: Long prose');
  });
});

describe('serializeLedger and replayed steps', () => {
  it('quotes what a replayed step did and showed this run, never the recorded verdict', () => {
    const { text } = serializeLedger(
      [
        step({
          api: 'agent.act',
          label: 'Get a visitor ticket from the desk.',
          explanation: 'replayed 1 recorded action(s) zero-turn from the trace cache; recorded verdict: the screen displays ticket TK-4972',
          cache: { mode: 'self-finalized', replayedActions: 1, totalActions: 1 },
          handoff: { appeared: ['Ticket TK-2011 · colour Violet · desk 8'], noted: [] },
          events: [
            { kind: 'backend', startedAt: 't', durationMs: 1, status: 'passed', name: 'tap', detail: 'tap button "Issue ticket"' },
          ],
        }),
      ],
      8_192,
    );
    expect(text).toContain('did: tap button "Issue ticket"');
    expect(text).toContain('saw: Ticket TK-2011 · colour Violet · desk 8');
    expect(text).not.toContain('TK-4972');
    expect(text).not.toContain('observed:');
  });
});
