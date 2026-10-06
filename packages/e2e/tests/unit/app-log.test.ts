/**
 * The app log: what an engine reports the app did on its own is checked at
 * the session seam and waits for a step recorder to take it. A log line goes
 * to the attempt's app log with the step that was running, else the last
 * one, redacted and bounded; where the app went is an event of that step.
 */

import { describe, expect, it } from 'vitest';
import { createEngineSession } from '../../src/engine/session.ts';
import type { AppLogEntry } from '../../src/engine/index.ts';
import type { AppEvent } from '../../src/engine/surface.ts';
import { StepRecorder } from '../../src/run/steps.ts';

const ERROR: AppLogEntry = { source: 'console', level: 'error', text: 'boom' };
const log = (entry: AppLogEntry): AppEvent => ({ kind: 'log', entry });

describe('StepRecorder.recordAppEvent', () => {
  it('keeps a line with the running step, a late one with the last step, and an early one with none', async () => {
    const steps = new StepRecorder('attempt');
    steps.recordAppEvent(log({ source: 'network', level: 'warning', text: 'GET /favicon.ico 404' }), '2026-01-01T00:00:00.000Z');
    await steps.run('app', 'app.open', '/', async () => {
      steps.recordAppEvent(log(ERROR));
    });
    steps.recordAppEvent(log({ source: 'error', level: 'error', text: 'TypeError:   x\n  is undefined' }));
    expect(steps.appLog().map(({ source, level, text, step }) => ({ source, level, text, step }))).toEqual([
      { source: 'network', level: 'warning', text: 'GET /favicon.ico 404', step: undefined },
      { source: 'console', level: 'error', text: 'boom', step: 0 },
      { source: 'error', level: 'error', text: 'TypeError: x is undefined', step: 0 },
    ]);
    expect(steps.all()[0]!.events).toEqual([]);
  });

  it('keeps a line made inside a running step with that step, though a later one started since', async () => {
    const steps = new StepRecorder('attempt');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = steps.run('app', 'app.open', '/', async () => {
      await held;
      steps.recordAppEvent(log(ERROR));
    });
    const second = steps.run('screen', 'screen.tap', 'Save', async () => undefined);
    await second;
    release();
    await first;
    expect(steps.appLog().map((entry) => entry.step)).toEqual([0]);
  });

  it('redacts a line before cutting it to the report bound, and counts errors and info apart against their caps', async () => {
    const steps = new StepRecorder('attempt', { redact: (text) => text.replaceAll('hunter2', '[secret]') });
    await steps.run('app', 'app.open', '/', async () => {
      steps.recordAppEvent(log({ source: 'console', level: 'error', text: `${'x'.repeat(295)}hunter2 and more` }));
      for (let index = 0; index < 300; index += 1) steps.recordAppEvent(log(ERROR));
      for (let index = 0; index < 150; index += 1) steps.recordAppEvent(log({ source: 'console', level: 'info', text: `tick ${index}` }));
    });
    const logged = steps.appLog();
    expect(logged.filter((entry) => entry.level === 'error')).toHaveLength(200);
    expect(logged.filter((entry) => entry.level === 'info')).toHaveLength(100);
    expect(logged[0]!.text).toBe(`${'x'.repeat(295)}[sec…`);
  });

  it('tells where the app went under the running step, and one before the first step under it', async () => {
    const steps = new StepRecorder('attempt');
    steps.recordAppEvent({ kind: 'navigation', line: 'navigated to /login' });
    await steps.run('app', 'app.open', '/', async () => {
      steps.recordAppEvent({ kind: 'navigation', line: 'the app opened a new tab at /help; the test stays on its page' });
    });
    expect(steps.all()[0]!.events.map(({ kind, detail }) => ({ kind, detail }))).toEqual([
      { kind: 'navigation', detail: 'navigated to /login' },
      { kind: 'navigation', detail: 'the app opened a new tab at /help; the test stays on its page' },
    ]);
    expect(steps.appLog()).toEqual([]);
  });
});

describe('the session app log route', () => {
  it('holds lines and navigations until a sink is routed, drops malformed ones, and sends later ones straight through', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'web' });
    session.appLog.push(ERROR);
    session.appLog.navigated('navigated to /login');
    session.appLog.push({ source: 'stdout', level: 'error', text: 'not a source' } as unknown as AppLogEntry);
    session.appLog.push({ source: 'navigation', level: 'info', text: 'no longer a source' } as unknown as AppLogEntry);
    session.appLog.push({ source: 'console', level: 'error', text: '   ' });
    session.appLog.navigated('  ');
    const heard: string[] = [];
    session.appLog.route((event) => heard.push(event.kind === 'log' ? event.entry.text : `↪ ${event.line}`));
    session.appLog.push({ source: 'network', level: 'warning', text: 'late' });
    expect(heard).toEqual(['boom', '↪ navigated to /login', 'late']);
  });
});
