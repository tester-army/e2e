/** Positional recording: twins the description cannot tell apart resolve by place, at the same count only. */

import { describe, expect, it } from 'vitest';
import { describeAction } from '../../src/agent/actions.ts';
import { describePosition, relocateDescriptor } from '../../src/cache/relocate.ts';
import { buildTraceEntry, readTraceEntry, type ActionTrace } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import type { RedactedNode } from '../../src/agent/observation.ts';
import { redactedNodes } from '../helpers/redacted.ts';

function button(id: string, name = 'Set up'): SemanticNode {
  return { ref: { id, revision: 'r' }, role: 'button', name };
}

function screen(...list: SemanticNode[]): ReadonlyMap<string, RedactedNode> {
  return redactedNodes(list);
}

describe('describePosition', () => {
  it('records where a target stands among the twins its description matches', () => {
    const cards = screen(button('a'), button('b'), button('c'));
    expect(describePosition(cards.get('b')!, undefined, cards)).toEqual({ index: 1, of: 3 });
  });

  it('records nothing for a target its description already names alone', () => {
    const cards = screen(button('a'), button('x', 'Save'));
    expect(describePosition(cards.get('x')!, undefined, cards)).toBeUndefined();
  });

  it('counts twins inside the recorded container only', () => {
    const rows = screen(
      { ref: { id: 'r1', revision: 'r' }, role: 'row', children: [{ ref: { id: 't1', revision: 'r' }, text: 'Alpha' }, button('d1', 'Delete')] },
      { ref: { id: 't1', revision: 'r' }, text: 'Alpha' },
      button('d1', 'Delete'),
      { ref: { id: 'r2', revision: 'r' }, role: 'row', children: [{ ref: { id: 't2', revision: 'r' }, text: 'Beta' }, button('d2', 'Delete')] },
      { ref: { id: 't2', revision: 'r' }, text: 'Beta' },
      button('d2', 'Delete'),
    );
    expect(describePosition(rows.get('d2')!, 'Beta', rows)).toBeUndefined();
  });
});

describe('relocation with a recorded position', () => {
  const descriptor = { role: 'button', name: 'Set up', position: { index: 1, of: 3 } };

  it('relocates to the same twin when the live screen shows the same number of them', () => {
    expect(relocateDescriptor(descriptor, screen(button('p'), button('q'), button('r')))).toEqual({
      kind: 'found',
      id: 'q',
    });
  });

  it('diverges as ambiguous when a twin appeared or vanished', () => {
    expect(relocateDescriptor(descriptor, screen(button('p'), button('q')))).toEqual({
      kind: 'failed',
      failure: 'target-ambiguous',
      candidates: ['p', 'q'],
    });
    expect(
      relocateDescriptor(descriptor, screen(button('p'), button('q'), button('r'), button('s'))),
    ).toEqual({ kind: 'failed', failure: 'target-ambiguous', candidates: ['p', 'q', 'r', 's'] });
  });

  it('still diverges without a recorded position', () => {
    expect(relocateDescriptor({ role: 'button', name: 'Set up' }, screen(button('p'), button('q')))).toEqual({
      kind: 'failed',
      failure: 'target-ambiguous',
      candidates: ['p', 'q'],
    });
  });

  it('names the position in the action summary and carries it on the target', () => {
    const cards = screen(button('a'), button('b'));
    const described = describeAction(
      { name: 'tap', node: cards.get('b')!, position: { index: 1, of: 2 } },
      { redact: (text) => text, redactCut: (text) => text },
    );
    expect(described.summary).toBe('tap button "Set up" (2 of 2)');
    expect(described.target?.position).toEqual({ index: 1, of: 2 });
  });

  it('survives the store and rejects a malformed position', () => {
    const payload: ActionTrace = {
      actions: [
        {
          name: 'tap',
          summary: 'tap button "Set up" (2 of 3)',
          target: { role: 'button', name: 'Set up', position: { index: 1, of: 3 } },
        },
      ],
      executor: { name: 'example-agent', version: '1' },
      summary: 'configured the card',
      startPath: '/integrations',
    };
    const stored = JSON.parse(JSON.stringify(buildTraceEntry(payload)));
    expect(readTraceEntry(stored)?.payload.actions[0]).toMatchObject({
      target: { position: { index: 1, of: 3 } },
    });
    for (const position of [{ index: 3, of: 3 }, { index: -1, of: 3 }, { index: 0, of: 0 }, { index: '1', of: 3 }, 'second']) {
      const broken = JSON.parse(JSON.stringify(stored));
      broken.payload.actions[0].target.position = position;
      expect(readTraceEntry(broken)).toBeUndefined();
    }
  });
});
