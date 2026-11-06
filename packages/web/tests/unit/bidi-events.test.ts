/**
 * Browser-wide events routed to the running BiDi attempt: context
 * ownership, user prompts through its dialog router (and never another
 * session's), and its app log.
 */

import { describe, expect, it } from 'vitest';
import type { AppLogEntry } from 'e2e/engine';
import { DialogRouter } from '../../src/driver/dialogs.ts';
import { routeEvents } from '../../src/driver/events.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import type { BidiSession } from '../../src/driver/session.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';
import { ErrorLatch } from '../../src/errors.ts';

/** The parts of a session the event router reads, owning `userContext`'s contexts. */
function attempt(owners: ContextTree, userContext: string) {
  const latch = new ErrorLatch();
  const log: AppLogEntry[] = [];
  const added: string[] = [];
  const lines: string[] = [];
  const visited: string[] = [];
  const session = {
    context: 'tab',
    ownNavigations: 0,
    lifetime: new AbortController().signal,
    latch,
    dialogs: new DialogRouter(latch),
    attempt: { appLog: (entry: AppLogEntry) => log.push(entry), navigation: (line: string) => lines.push(line) },
    visit: async (url: string) => void visited.push(url),
    network: { addContext: async (context: string) => void added.push(context), removeContext: async () => undefined, retire: () => undefined },
    owns: (context: string | null | undefined) => context != null && owners.owner(context) === userContext,
  };
  return { session: session as unknown as BidiSession, state: session, log, added, latch, lines, visited };
}

/** A user prompt event in `context`. */
function prompt(context: string, type = 'confirm') {
  return { context, handler: 'ignore', message: 'Really delete everything?', type };
}

describe('routeEvents', () => {
  it('answers a prompt in the attempt’s context through its dialog router', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session } = attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'tab', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    let seen = '';
    session.dialogs.add(async (dialog) => {
      seen = `${dialog.type}: ${dialog.message}`;
      await dialog.accept();
    });
    fake.emit('browsingContext.userPromptOpened', prompt('tab'));
    await settle();
    expect(seen).toBe('confirm: Really delete everything?');
    expect(fake.commands('browsingContext.handleUserPrompt').map((command) => command.params)).toEqual([{ context: 'tab', accept: true }]);
  });

  it('leaves a prompt in another session’s context alone', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session } = attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'theirs', userContext: 'other', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.userPromptOpened', prompt('theirs'));
    await settle();
    expect(fake.commands('browsingContext.handleUserPrompt')).toEqual([]);
  });

  it('dismisses an unhandled prompt and fails the next step naming it', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session, latch } = attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'tab', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.userPromptOpened', prompt('tab', 'alert'));
    await settle();
    expect(fake.commands('browsingContext.handleUserPrompt').map((command) => command.params)).toEqual([{ context: 'tab', accept: false }]);
    expect(() => latch.throwPending()).toThrow('unhandled alert dialog: Really delete everything?');
  });

  it('gives a frame its parent’s owner, covers a tab the app opens, and logs only the attempt’s pages', () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session, log, added } = attempt(owners, 'mine');
    const off = routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', { context: 'tab', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.contextCreated', { context: 'frame', parent: 'tab', url: 'about:blank', children: null, clientWindow: 'w' });
    fake.emit('browsingContext.contextCreated', { context: 'popup', userContext: 'mine', parent: null, originalOpener: 'tab', url: 'about:blank', children: null, clientWindow: 'w' });
    expect(owners.owner('frame')).toBe('mine');
    expect(added).toEqual(['popup']);
    const entry = (context: string, text: string) => ({ type: 'console', level: 'error', text, timestamp: 0, method: 'error', args: [], source: { realm: 'r', context } });
    fake.emit('log.entryAdded', entry('frame', 'boom'));
    fake.emit('log.entryAdded', entry('elsewhere', 'not mine'));
    fake.emit('log.entryAdded', entry('tab', 'Failed to load resource: 404'));
    off();
    fake.emit('log.entryAdded', entry('tab', 'after unsubscribe'));
    expect(log).toEqual([{ source: 'console', level: 'error', text: 'boom' }]);
  });

  it('tells where the app went in event order, never the driver’s own navigations, names each frame and tab once, and visits every document it starts or lands at', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session, state, lines, visited } = attempt(owners, 'mine');
    fake.on('script.callFunction', (params) => ({
      result: { type: 'success', realm: 'r', result: { type: 'string', value: (params['target'] as { context: string }).context === 'frame' ? 'pay' : '' } },
    }));
    routeEvents(fake.connection, owners, () => session);
    const created = (context: string, extra: Record<string, unknown> = {}) =>
      fake.emit('browsingContext.contextCreated', { context, userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w', originalOpener: null, ...extra });
    const nav = (context: string, url: string) => ({ context, url, navigation: 'n', timestamp: 0 });
    created('tab');
    created('scratch');
    fake.emit('browsingContext.contextCreated', { context: 'frame', parent: 'tab', url: 'about:blank', children: null, clientWindow: 'w' });
    state.ownNavigations = 1;
    fake.emit('browsingContext.navigationCommitted', nav('tab', 'http://app.test/'));
    state.ownNavigations = 0;
    fake.emit('browsingContext.navigationStarted', nav('tab', 'http://app.test/checkout'));
    fake.emit('browsingContext.navigationCommitted', nav('tab', 'http://app.test/checkout'));
    fake.emit('browsingContext.historyUpdated', { context: 'tab', url: 'http://app.test/checkout?step=2', timestamp: 0 });
    fake.emit('browsingContext.navigationCommitted', nav('frame', 'http://pay.test/embed'));
    fake.emit('browsingContext.navigationCommitted', nav('frame', 'about:srcdoc'));
    fake.emit('browsingContext.navigationCommitted', nav('scratch', 'http://app.test/'));
    created('popup', { originalOpener: 'tab' });
    fake.emit('browsingContext.navigationCommitted', nav('popup', 'http://app.test/help'));
    fake.emit('browsingContext.navigationCommitted', nav('popup', 'http://app.test/help/2'));
    created('blank', { originalOpener: 'tab' });
    fake.emit('browsingContext.contextDestroyed', { context: 'blank', userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w' });
    await settle();
    expect(lines).toEqual([
      'navigated to http://app.test/checkout',
      'navigated to http://app.test/checkout?step=2',
      'frame "pay" loaded http://pay.test/embed',
      'the app opened a new tab at http://app.test/help; the test stays on its page',
      'the new tab navigated to http://app.test/help/2',
      'the app opened a new tab; the test stays on its page',
    ]);
    expect(new Set(visited)).toEqual(new Set(['http://app.test/', 'http://app.test/checkout', 'http://app.test/checkout?step=2', 'http://pay.test/embed', 'http://app.test/help', 'http://app.test/help/2']));
  });
});
