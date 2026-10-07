/** A replay walks fallback rungs, most stable evidence first, once the exact match finds nothing. */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { redactedNodes } from '../helpers/redacted.ts';
import { relocateExact, relocateWithFallbacks } from '../../src/cache/locate.ts';
import type { TraceTargetDescriptor } from '../../src/cache/trace.ts';

function node(id: string, fields: Omit<SemanticNode, 'ref'>): SemanticNode {
  return { ref: { id, revision: 'r' }, ...fields };
}

const SAVE: TraceTargetDescriptor = { role: 'button', name: 'Save', testId: 'save' };

describe('relocateWithFallbacks', () => {
  it('matches exactly first and names no fallback', () => {
    const nodes = redactedNodes([node('a', { role: 'button', name: 'Save', testId: 'save' }), node('b', { role: 'button', name: 'Cancel' })]);
    expect(relocateWithFallbacks(SAVE, nodes)).toEqual({ kind: 'found', id: 'a' });
  });

  it('keeps the test id when the label changed', () => {
    const nodes = redactedNodes([node('a', { role: 'button', name: 'Save changes', testId: 'save' }), node('b', { role: 'button', name: 'Cancel' })]);
    expect(relocateExact(SAVE, nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
    expect(relocateWithFallbacks(SAVE, nodes)).toEqual({ kind: 'found', id: 'a', fallback: 'test-id' });
  });

  it('keeps the test id when the label and the role changed', () => {
    const nodes = redactedNodes([node('a', { role: 'link', name: 'Save draft', testId: 'save' })]);
    expect(relocateWithFallbacks(SAVE, nodes)).toEqual({ kind: 'found', id: 'a', fallback: 'test-id' });
  });

  it('prefers the test id with its role among nodes sharing the test id', () => {
    const nodes = redactedNodes([node('a', { role: 'heading', name: 'Saving', testId: 'save' }), node('b', { role: 'button', name: 'Store', testId: 'save' })]);
    expect(relocateWithFallbacks(SAVE, nodes)).toEqual({ kind: 'found', id: 'b', fallback: 'test-id' });
  });

  it('keeps the role and name when the placeholder changed', () => {
    const recorded: TraceTargetDescriptor = { role: 'textbox', name: 'Email', placeholder: 'you@example.com' };
    const nodes = redactedNodes([node('a', { role: 'textbox', name: 'Email', attributes: { placeholder: 'name@company.com' } })]);
    expect(relocateWithFallbacks(recorded, nodes)).toEqual({ kind: 'found', id: 'a', fallback: 'accessible' });
  });

  it('follows the name across a role family, never out of it', () => {
    const recorded: TraceTargetDescriptor = { role: 'link', name: 'Settings' };
    expect(relocateWithFallbacks(recorded, redactedNodes([node('a', { role: 'button', name: 'Settings' })]))).toEqual({
      kind: 'found',
      id: 'a',
      fallback: 'role-family',
    });
    expect(relocateWithFallbacks(recorded, redactedNodes([node('a', { role: 'heading', name: 'Settings' })]))).toEqual({
      kind: 'failed',
      failure: 'target-not-found',
    });
    expect(relocateWithFallbacks({ role: 'checkbox', name: 'Notify me' }, redactedNodes([node('a', { role: 'switch', name: 'Notify me' })]))).toEqual({
      kind: 'found',
      id: 'a',
      fallback: 'role-family',
    });
  });

  it('hands off when the test id and the name point at different nodes', () => {
    const nodes = redactedNodes([node('a', { role: 'button', name: 'Discard', testId: 'save' }), node('b', { role: 'button', name: 'Save', testId: 'save-v2' })]);
    expect(relocateWithFallbacks(SAVE, nodes)).toEqual({ kind: 'failed', failure: 'target-ambiguous', candidates: ['a', 'b'], conflict: true });
  });

  it('hands off when the name lands outside the controls still carrying the recorded test id, however many there are', () => {
    const recorded: TraceTargetDescriptor = { role: 'button', name: 'Archive', testId: 'row-action' };
    const nodes = redactedNodes([
      node('a', { role: 'button', name: 'Delete', testId: 'row-action' }),
      node('b', { role: 'button', name: 'Rename', testId: 'row-action' }),
      node('c', { role: 'button', name: 'Archive', testId: 'toolbar-archive' }),
    ]);
    expect(relocateWithFallbacks(recorded, nodes)).toEqual({ kind: 'failed', failure: 'target-ambiguous', candidates: ['a', 'b', 'c'], conflict: true });
  });

  it('holds a fallback name pick to the same rule', () => {
    const recorded: TraceTargetDescriptor = { role: 'button', name: 'Archive', testId: 'row-action' };
    const nodes = redactedNodes([
      node('a', { role: 'button', name: 'Delete', testId: 'row-action' }),
      node('b', { role: 'button', name: 'Rename', testId: 'row-action' }),
      node('c', { role: 'link', name: 'Archive' }),
    ]);
    expect(relocateExact(recorded, nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
    expect(relocateWithFallbacks(recorded, nodes)).toEqual({ kind: 'failed', failure: 'target-ambiguous', candidates: ['a', 'b', 'c'], conflict: true });
  });

  it('never falls back from an ambiguous exact match, since every rung only widens it', () => {
    const recorded: TraceTargetDescriptor = { role: 'button', name: 'Delete' };
    const nodes = redactedNodes([node('a', { role: 'button', name: 'Delete' }), node('b', { role: 'button', name: 'Delete' })]);
    expect(relocateWithFallbacks(recorded, nodes)).toEqual({ kind: 'failed', failure: 'target-ambiguous', candidates: ['a', 'b'] });
  });

  it('skips a rung its twins make ambiguous and settles on the next one', () => {
    const recorded: TraceTargetDescriptor = { role: 'button', name: 'Archive', testId: 'row-action' };
    const nodes = redactedNodes([
      node('a', { role: 'button', name: 'Archive project', testId: 'row-action' }),
      node('b', { role: 'button', name: 'Delete', testId: 'row-action' }),
    ]);
    expect(relocateWithFallbacks(recorded, nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
    const renamed = redactedNodes([
      node('a', { role: 'button', name: 'Archive', testId: 'row-action-1' }),
      node('b', { role: 'button', name: 'Delete', testId: 'row-action-2' }),
    ]);
    expect(relocateWithFallbacks(recorded, renamed)).toEqual({ kind: 'found', id: 'a' });
  });

  it('resolves a recorded place among the same count of twins on a fallback rung', () => {
    const recorded: TraceTargetDescriptor = { role: 'button', name: 'Set up', testId: 'setup', position: { index: 1, of: 3 } };
    const nodes = redactedNodes(['p', 'q', 'r'].map((id) => node(id, { role: 'button', name: 'Configure', testId: 'setup' })));
    expect(relocateWithFallbacks(recorded, nodes)).toEqual({ kind: 'found', id: 'q', fallback: 'test-id' });
    const fewer = redactedNodes(['p', 'q'].map((id) => node(id, { role: 'button', name: 'Configure', testId: 'setup' })));
    expect(relocateWithFallbacks(recorded, fewer)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('holds a recorded container on every rung', () => {
    const row = (id: string, key: string, label: string): SemanticNode =>
      node(`r-${id}`, {
        role: 'row',
        children: [node(`c-${id}`, { role: 'cell', text: key }), node(id, { role: 'button', name: label, testId: 'delete' })],
      });
    const tree = row('d1', 'Vendor list', 'Remove');
    const flat = [tree, ...(tree.children ?? []).flatMap((child) => [child, ...(child.children ?? [])])];
    const nodes = redactedNodes(flat);
    expect(relocateWithFallbacks({ role: 'button', name: 'Delete', testId: 'delete', within: 'Budget draft' }, nodes)).toEqual({
      kind: 'failed',
      failure: 'target-not-found',
    });
    expect(relocateWithFallbacks({ role: 'button', name: 'Delete', testId: 'delete', within: 'Vendor list' }, nodes)).toEqual({
      kind: 'found',
      id: 'd1',
      fallback: 'test-id',
    });
  });

  it('gives an anonymous control no fallback', () => {
    const recorded: TraceTargetDescriptor = { role: 'textbox', position: { index: 0, of: 1 } };
    const nodes = redactedNodes([node('a', { role: 'searchbox' })]);
    expect(relocateWithFallbacks(recorded, nodes)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('reads a label whose count or time moved as another label, unless a test id still names the control', () => {
    const likes: TraceTargetDescriptor = { role: 'button', name: 'Like (0 likes)' };
    expect(relocateWithFallbacks(likes, redactedNodes([node('a', { role: 'button', name: 'Like (1 like)' })]))).toEqual({
      kind: 'failed',
      failure: 'target-not-found',
    });
    const inbox: TraceTargetDescriptor = { role: 'link', name: 'Inbox (3 messages)', testId: 'inbox' };
    expect(relocateWithFallbacks(inbox, redactedNodes([node('a', { role: 'link', name: 'Inbox (4 messages)', testId: 'inbox' })]))).toEqual({
      kind: 'found',
      id: 'a',
      fallback: 'test-id',
    });
  });

  it('never moves onto a neighbour whose number names it', () => {
    for (const [recorded, live] of [
      ['Delete item 3', 'Delete item 4'],
      ['Open item 3 menu', 'Open item 4 menu'],
      ['Delete row 3 permanently', 'Delete row 4 permanently'],
      ['Player 1 score', 'Player 2 score'],
      ['Room 101 east', 'Room 102 east'],
      ['Seat 12 window', 'Seat 14 window'],
      ['Team 3 members', 'Team 4 members'],
      ['Page 2', 'Page 3'],
      ['Order #1234', 'Order #9876'],
      ['Count: 1', 'Count: 0'],
    ] as const) {
      const nodes = redactedNodes([node('a', { role: 'button', name: live })]);
      expect(relocateWithFallbacks({ role: 'button', name: recorded }, nodes), recorded).toEqual({ kind: 'failed', failure: 'target-not-found' });
    }
  });

  it('treats a lone survivor of recorded twins as ambiguous, on every rung', () => {
    const recorded: TraceTargetDescriptor = { role: 'button', name: 'Like', position: { index: 0, of: 3 } };
    expect(relocateWithFallbacks(recorded, redactedNodes([node('a', { role: 'button', name: 'Like' }), node('b', { role: 'button', name: 'Liked' })]))).toEqual({
      kind: 'failed',
      failure: 'target-ambiguous',
      candidates: ['a'],
    });
  });

  it('finds a tapped toggle only in the state the recording tapped it in, since the tap would flip it the other way', () => {
    const off: TraceTargetDescriptor = { role: 'checkbox', name: 'Mushrooms', testId: 'topping-mushrooms', states: [] };
    const on: TraceTargetDescriptor = { ...off, states: ['checked'] };
    const unchecked = redactedNodes([node('a', { role: 'checkbox', name: 'Mushrooms', testId: 'topping-mushrooms', states: { checked: false } })]);
    expect(relocateWithFallbacks(off, unchecked)).toEqual({ kind: 'found', id: 'a' });
    expect(relocateWithFallbacks(on, unchecked)).toEqual({ kind: 'failed', failure: 'target-not-found' });
    // A label that spells the state (`✓, Mushrooms`) changes with it; the test id rung still holds the state.
    expect(relocateWithFallbacks({ ...on, name: '✓, Mushrooms' }, unchecked)).toEqual({ kind: 'failed', failure: 'target-not-found' });
  });

  it('counts the toggle still carrying the recorded test id against a name match, whatever state it is in', () => {
    const on: TraceTargetDescriptor = { role: 'checkbox', name: 'Mushrooms', testId: 'topping-mushrooms', states: ['checked'] };
    const nodes = redactedNodes([
      node('a', { role: 'checkbox', name: 'Mushroom sauce', testId: 'topping-mushrooms', states: { checked: false } }),
      node('b', { role: 'checkbox', name: 'Mushrooms', states: { checked: true } }),
    ]);
    expect(relocateWithFallbacks(on, nodes)).toEqual({ kind: 'failed', failure: 'target-ambiguous', candidates: ['a', 'b'], conflict: true });
  });
});
