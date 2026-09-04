/**
 * The conversation backend through the public contract, with a scripted
 * transport and a mocked AI SDK: the manifest, the send/observe/approve
 * loop, tool-call recording, id staleness, restart, and the path anchor. No
 * model and no network: what is asserted is how the backend drives a
 * transport and folds replies into the transcript.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BackendError,
  type BackendFixtureContext,
  type BackendHandle,
  type OperationContext,
  type SemanticNode,
} from '@e2edev/e2e/backend';
import { createFakeTransport, sdkMock, text, toolApproval, toolOutput, type FakeTransport } from '../helpers/fake-transport.ts';

vi.mock('ai', () => sdkMock());

// Imported after the mock is registered so the surface's dynamic import resolves to it.
const { buildBackend } = await import('../../src/backend.ts');
const { ConversationSurface } = await import('../../src/surface.ts');
const { createConversationFixture } = await import('../../src/conversation.ts');
type ConversationSurfaceT = InstanceType<typeof ConversationSurface>;

function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1' };
}

const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 5_000 });

interface Harness {
  readonly backend: BackendHandle;
  readonly transport: FakeTransport;
  readonly surface: ConversationSurfaceT;
}

function harness(options: { history?: { id: string; role: 'user' | 'assistant'; parts: { type: string; text?: string }[] }[] } = {}): Harness {
  const transport = createFakeTransport();
  const surface = new ConversationSurface({ transport, ...(options.history === undefined ? {} : { history: options.history }), name: 'support' });
  return { backend: buildBackend(surface), transport, surface };
}

async function open(h: Harness): Promise<void> {
  await h.backend.init!({
    runId: 'run-1',
    targetName: 'support',
    projectRoot: '/p',
    app: { allowedOrigins: [] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal: new AbortController().signal,
  });
  await h.backend.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp/none', signal: new AbortController().signal });
}

async function findNode(h: Harness, predicate: (node: SemanticNode) => boolean): Promise<SemanticNode> {
  const snapshot = await h.backend.observe!(operation());
  const found = [...walk(snapshot.nodes)].find((candidate) => predicate(candidate));
  if (found === undefined) throw new Error('node not found');
  return found;
}

function* walk(nodes: readonly SemanticNode[]): Generator<SemanticNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children ?? []);
  }
}

async function failure(run: () => Promise<unknown>): Promise<BackendError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BackendError) return error;
    throw error;
  }
  throw new Error('expected a BackendError');
}

function fixtureContext(): BackendFixtureContext {
  const signal = new AbortController().signal;
  return {
    targetName: 'support',
    app: { allowedOrigins: [], resolveUrl: (url) => url },
    timeouts: { test: 60_000, action: 30_000, assertion: 5_000 },
    signal,
    operation: () => operation(signal),
    attachArtifact: () => undefined,
    attachViewport: () => undefined,
    locator: () => {
      throw new Error('unused');
    },
    screen: () => {
      throw new Error('unused');
    },
    expectable: (target) => target as never,
  };
}

describe('manifest', () => {
  it('declares observation, actions, location, the conversation fixture, restart, and a url', () => {
    const { backend } = harness();
    expect([...backend.capabilities].toSorted()).toEqual(['actions', 'conversation', 'location', 'observation']);
    expect(backend.name).toBe('conversation');
    expect(backend.version).not.toBe('unknown');
    expect(Object.keys(backend.app!)).toEqual(['restart']);
    expect(backend.url).toBeDefined();
    expect(backend.artifacts).toBeUndefined();
  });

  it('refuses zero or several targets', () => {
    expect(() => new ConversationSurface({})).toThrow(/exactly one/);
    expect(() => new ConversationSurface({ agent: {}, api: 'http://x' })).toThrow(/exactly one/);
  });
});

describe('send and observe', () => {
  it('sends the composer draft and shows the reply as an assistant message', async () => {
    const h = harness();
    await open(h);
    h.transport.reply([text('Hello, how can I help?')]);

    const composer = await findNode(h, (candidate) => candidate.role === 'textbox');
    await h.backend.perform!(composer.ref, { kind: 'fill', value: 'hi there', sensitive: false }, operation());
    const staged = await findNode(h, (candidate) => candidate.role === 'textbox');
    expect(staged.value).toBe('hi there');
    await h.backend.perform!(staged.ref, { kind: 'press', key: 'Enter' }, operation());

    // The transport saw the user message; the reply is on screen.
    expect(h.transport.sends[0]!.map((message) => message.role)).toEqual(['user']);
    await expect(findNode(h, (candidate) => candidate.text === 'Hello, how can I help?')).resolves.toBeDefined();
    expect(h.surface.lastText()).toBe('Hello, how can I help?');
    expect(h.surface.status()).toBe('ready');
  });

  it('records tool calls and pauses on an approval, hiding the composer until answered', async () => {
    const h = harness();
    await open(h);
    h.transport.reply([text('Looking up Bob.'), toolOutput('lookup', { name: 'Bob' }, { id: 'b-1' }), toolApproval('wire', { to: 'b-1', amount: 50 })]);
    await h.surface.send('wire $50 to Bob', operation());

    expect(h.surface.status()).toBe('awaiting-approval');
    expect(h.surface.toolCalls().map((call) => [call.name, call.state])).toEqual([
      ['lookup', 'output-available'],
      ['wire', 'approval-requested'],
    ]);
    // No composer while paused; an Approve button instead.
    await expect(findNode(h, (candidate) => candidate.role === 'textbox')).rejects.toThrow();
    await expect(findNode(h, (candidate) => candidate.role === 'button' && candidate.name === 'Approve')).resolves.toBeDefined();
  });
});

describe('approvals', () => {
  it('resumes the turn when Approve is tapped and records the wire executing', async () => {
    const h = harness();
    await open(h);
    h.transport.reply([toolApproval('wire', { to: 'Bob', amount: 50 })]);
    await h.surface.send('wire $50 to Bob', operation());

    h.transport.reply([toolOutput('wire', { to: 'Bob', amount: 50 }, { ok: true }), text('Done, $50 sent.')]);
    const approve = await findNode(h, (candidate) => candidate.role === 'button' && candidate.name === 'Approve');
    await h.backend.perform!(approve.ref, { kind: 'tap' }, operation());

    expect(h.surface.status()).toBe('ready');
    expect(h.surface.lastText()).toBe('Done, $50 sent.');
    expect(h.surface.toolCalls('wire').at(-1)!.state).toBe('output-available');
    // The resume re-sent the transcript with the approval answered.
    expect(h.transport.sends).toHaveLength(2);
    const resumed = h.transport.sends[1]!.at(-1)!;
    expect(resumed.parts.some((part) => part.state === 'approval-responded' && part.approval?.approved === true)).toBe(true);
  });

  it('denies through the fixture and never lets the tool run', async () => {
    const h = harness();
    await open(h);
    const conversation = createConversationFixture(h.surface, fixtureContext());
    h.transport.reply([toolApproval('wire', { to: 'Bob', amount: 50 })]);
    await conversation.send('wire $50 to Bob');
    expect(conversation.awaitingApproval()).toBe(true);

    h.transport.reply([text('Okay, I will not send it.')]);
    await conversation.deny('wire', { reason: 'not authorized' });
    expect(conversation.status()).toBe('ready');
    expect(conversation.toolCalls('wire').some((call) => call.state === 'output-available')).toBe(false);
    const resumed = h.transport.sends[1]!.at(-1)!;
    expect(resumed.parts.some((part) => part.approval?.approved === false && part.approval?.reason === 'not authorized')).toBe(true);
  });
});

describe('lifecycle and errors', () => {
  it('restarts to the seeded history and drops the live transcript', async () => {
    const seed = [{ id: 'h1', role: 'user' as const, parts: [{ type: 'text', text: 'earlier' }] }];
    const h = harness({ history: seed });
    await open(h);
    h.transport.reply([text('one')]);
    await h.surface.send('first', operation());
    expect(h.surface.transcript().length).toBe(3);
    await h.backend.app!.restart!(operation());
    expect(h.surface.transcript().map((message) => message.role)).toEqual(['user']);
  });

  it('rejects a stale ref and acting outside an attempt', async () => {
    const h = harness();
    await open(h);
    h.transport.reply([text('one')]);
    const composer = await findNode(h, (candidate) => candidate.role === 'textbox');
    // A later observation mints a fresh generation, so the first ref no longer binds.
    await h.backend.observe!(operation());
    const stale = await failure(() => h.backend.perform!(composer.ref, { kind: 'fill', value: 'x', sensitive: false }, operation()));
    expect(stale.code).toBe('NODE_STALE');
    expect(stale.retryable).toBe(true);

    await h.backend.endAttempt!(cleanup());
    const closed = await failure(() => h.backend.observe!(operation()));
    expect(closed.code).toBe('INVALID_STATE');
  });

  it('anchors the url on the agent label and status', async () => {
    const h = harness();
    await open(h);
    expect(await h.backend.url!(operation())).toBe('app://conversation/support/ready');
    h.transport.reply([toolApproval('wire', { to: 'Bob', amount: 1 })]);
    await h.surface.send('wire', operation());
    expect(await h.backend.url!(operation())).toBe('app://conversation/support/awaiting-approval');
  });
});
