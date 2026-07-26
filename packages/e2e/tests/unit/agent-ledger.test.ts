import { describe, expect, it } from 'vitest';
import { Ledger, MAX_HANDOFF_BYTES } from '../../src/agent/ledger.ts';

describe('Ledger', () => {
  it('presents entries in chronological order', () => {
    const ledger = new Ledger(8_192);
    ledger.append({ method: 'app.open', label: '/', status: 'passed' });
    ledger.append({ method: 'agent.tap', label: 'the buy button', status: 'passed' });
    const { text } = ledger.serialize();
    expect(text.indexOf('app.open')).toBeLessThan(text.indexOf('agent.tap'));
    expect(text).toContain('1. app.open passed :: /');
    expect(text).toContain('2. agent.tap passed :: the buy button');
  });

  it('drops the oldest entries and reports how many were omitted', () => {
    const ledger = new Ledger(200);
    for (let index = 0; index < 40; index += 1) {
      ledger.append({ method: 'agent.tap', label: `target-${index}`, status: 'passed' });
    }
    const { text, bytes } = ledger.serialize();
    expect(bytes).toBeLessThanOrEqual(200 + text.split('\n')[0]!.length);
    expect(text.split('\n')[0]).toMatch(/^\[\d+ earlier step\(s\) omitted\]$/);
    expect(text).toContain('target-39');
    expect(text).not.toContain('target-0"');
  });

  it('truncates one handoff to the bounded size', () => {
    const ledger = new Ledger(65_536);
    ledger.append({ method: 'agent.assert', label: 'x', status: 'passed', handoff: 'y'.repeat(2_000) });
    const { text } = ledger.serialize();
    const handoff = /observed: (y+)/.exec(text)?.[1] ?? '';
    expect(handoff.length).toBe(MAX_HANDOFF_BYTES);
  });

  it('replaces the newest handoff without reordering entries', () => {
    const ledger = new Ledger(8_192);
    ledger.append({ method: 'agent.tap', label: 'a', status: 'passed' });
    ledger.append({ method: 'agent.assert', label: 'b', status: 'passed' });
    ledger.setLatestHandoff('the dashboard is visible');
    const { text } = ledger.serialize();
    expect(ledger.size()).toBe(2);
    expect(text).toContain('observed: the dashboard is visible');
    expect(text.indexOf('agent.tap')).toBeLessThan(text.indexOf('agent.assert'));
  });

  it('strips control characters from untrusted labels and handoffs', () => {
    const ledger = new Ledger(8_192);
    ledger.append({
      method: 'agent.assert',
      label: 'a\u0007b',
      status: 'failed',
      handoff: 'ignore\u0000policy',
    });
    const { text } = ledger.serialize();
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u0000');
    expect(text).toContain('\uFFFD');
  });
});
