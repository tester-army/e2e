/**
 * The app log: what an engine reports the app did on its own is checked at
 * the session seam, waits for a step recorder to take it, and is filed under
 * the step that was running, else the last one, redacted and bounded.
 */

import { describe, expect, it } from 'vitest';
import { createEngineSession } from '../../src/engine/session.ts';
import type { AppLogEntry } from '../../src/engine/index.ts';
import { StepRecorder } from '../../src/run/steps.ts';

const ERROR: AppLogEntry = { source: 'console', level: 'error', text: 'boom' };

describe('StepRecorder.recordAppLog', () => {
  it('files an entry under the running step, a late one under the last step, and an early one under the first', async () => {
    const steps = new StepRecorder('attempt');
    steps.recordAppLog({ source: 'network', level: 'warning', text: 'GET /favicon.ico 404' }, '2026-01-01T00:00:00.000Z');
    await steps.run('app', 'app.open', '/', async () => {
      steps.recordAppLog(ERROR);
    });
    steps.recordAppLog({ source: 'error', level: 'error', text: 'TypeError:   x\n  is undefined' });
    const [step] = steps.all();
    expect(step?.events.map(({ name, level, status, detail }) => ({ name, level, status, detail }))).toEqual([
      { name: 'network', level: 'warning', status: 'passed', detail: 'GET /favicon.ico 404' },
      { name: 'console', level: 'error', status: 'failed', detail: 'boom' },
      { name: 'error', level: 'error', status: 'failed', detail: 'TypeError: x is undefined' },
    ]);
  });

  it('redacts an entry before cutting it to the report bound, and stops at the per-attempt cap', async () => {
    const steps = new StepRecorder('attempt', { redact: (text) => text.replaceAll('hunter2', '[secret]') });
    await steps.run('app', 'app.open', '/', async () => {
      steps.recordAppLog({ source: 'console', level: 'error', text: `${'x'.repeat(295)}hunter2 and more` });
      for (let index = 0; index < 300; index += 1) steps.recordAppLog(ERROR);
    });
    const events = steps.all()[0]!.events;
    expect(events).toHaveLength(200);
    expect(events[0]!.detail).toHaveLength(300);
    expect(events[0]!.detail).not.toContain('hunter');
  });
});

describe('the session app log route', () => {
  it('holds entries until a sink is routed, drops malformed ones, and sends later ones straight through', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'web' });
    session.appLog.push(ERROR);
    session.appLog.push({ source: 'stdout', level: 'error', text: 'not a source' } as unknown as AppLogEntry);
    session.appLog.push({ source: 'console', level: 'error', text: '   ' });
    const heard: string[] = [];
    session.appLog.route((entry) => heard.push(entry.text));
    session.appLog.push({ source: 'network', level: 'warning', text: 'late' });
    expect(heard).toEqual(['boom', 'late']);
  });
});
