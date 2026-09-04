import { describe, expect, it } from 'vitest';
import type { LocatorExpression, SemanticNode } from '@e2edev/e2e/backend';
import { resolveExpression } from '../../src/locate.ts';
import {
  lastAssistantText,
  pendingApprovals,
  projectTranscript,
  textOf,
  toolCallsOf,
  type UIMessageLike,
} from '../../src/messages.ts';

function minted(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `n${counter}`;
  };
}

const transcript: UIMessageLike[] = [
  { id: 's', role: 'system', parts: [{ type: 'text', text: 'You are a support agent.' }] },
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'wire $50 to Bob' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Looking up Bob.' },
      { type: 'tool-lookup', toolCallId: 'c1', state: 'output-available', input: { name: 'Bob' }, output: { id: 'b-1' } },
      { type: 'tool-wire', toolCallId: 'c2', state: 'approval-requested', input: { to: 'b-1', amount: 50 }, approval: { id: 'ap-1' } },
    ],
  },
];

describe('transcript readers', () => {
  it('concatenates a message\'s text parts', () => {
    expect(textOf(transcript[2] as UIMessageLike)).toBe('Looking up Bob.');
    expect(lastAssistantText(transcript)).toBe('Looking up Bob.');
  });

  it('lists every tool call with its state, input, and output', () => {
    const calls = toolCallsOf(transcript);
    expect(calls).toEqual([
      { name: 'lookup', toolCallId: 'c1', state: 'output-available', input: { name: 'Bob' }, output: { id: 'b-1' } },
      { name: 'wire', toolCallId: 'c2', state: 'approval-requested', input: { to: 'b-1', amount: 50 }, output: undefined, approvalId: 'ap-1' },
    ]);
  });

  it('finds the approval the newest turn is blocked on', () => {
    expect(pendingApprovals(transcript)).toEqual([{ toolCallId: 'c2', name: 'wire', approvalId: 'ap-1', input: { to: 'b-1', amount: 50 } }]);
    const answered: UIMessageLike[] = [
      { id: 'a', role: 'assistant', parts: [{ type: 'tool-wire', toolCallId: 'c2', state: 'output-available', input: {}, output: {} }] },
    ];
    expect(pendingApprovals(answered)).toEqual([]);
  });
});

describe('projectTranscript', () => {
  it('is one application root, a node per message, tool status nodes, and Approve/Deny buttons under a paused tool', () => {
    const projected = projectTranscript(transcript, { agentLabel: 'support', status: 'awaiting-approval', draft: '', mintId: minted() });
    const root = projected.root;
    expect(root.role).toBe('application');
    expect(root.name).toBe('support');
    expect((root.children ?? []).map((child) => child.role)).toEqual(['system', 'user', 'assistant']);

    const assistant = (root.children ?? [])[2] as SemanticNode;
    const toolNodes = (assistant.children ?? []).filter((child) => child.role === 'status');
    expect(toolNodes.map((node) => node.name)).toEqual(['tool lookup', 'tool wire']);
    const wire = toolNodes[1] as SemanticNode;
    expect((wire.children ?? []).map((child) => [child.role, child.name])).toEqual([
      ['button', 'Approve'],
      ['button', 'Deny'],
    ]);
    // Paused on an approval: no composer is offered.
    expect((root.children ?? []).some((child) => child.role === 'textbox')).toBe(false);
  });

  it('offers a focused composer when the turn is ready, carrying the draft as its value', () => {
    const ready: UIMessageLike[] = [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }];
    const projected = projectTranscript(ready, { agentLabel: 'support', status: 'ready', draft: 'hello', mintId: minted() });
    const composer = (projected.root.children ?? []).find((child) => child.role === 'textbox') as SemanticNode;
    expect(composer.name).toBe('Message');
    expect(composer.value).toBe('hello');
    expect(composer.states).toEqual({ focused: true });
  });
});

describe('resolveExpression', () => {
  const projected = projectTranscript(transcript, { agentLabel: 'support', status: 'awaiting-approval', draft: '', mintId: minted() });
  const ids = (expression: LocatorExpression) => resolveExpression(expression, projected.index).map((entry) => entry.node.name ?? entry.node.text);

  it('finds messages by text and buttons by role and name', () => {
    expect(ids({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Looking up Bob.', exact: true } } })).toEqual(['Looking up Bob.']);
    expect(
      ids({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Approve', exact: true } } }),
    ).toEqual(['Approve']);
  });

  it('scopes a query to the wire tool node', () => {
    const wire: LocatorExpression = {
      kind: 'query',
      query: { kind: 'label', value: { kind: 'string', value: 'tool wire', exact: true } },
    };
    const denyInWire: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Deny', exact: true } },
      scope: wire,
    };
    expect(ids(denyInWire)).toEqual(['Deny']);
  });
});
