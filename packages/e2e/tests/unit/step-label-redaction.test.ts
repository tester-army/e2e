/** StepRecorder.run: the label a step is recorded and announced with passes the attempt redactor. */

import { describe, expect, it } from 'vitest';
import { SecretLedger } from '../../src/internal/redact.ts';
import { StepRecorder, type StepProgress } from '../../src/run/steps.ts';

describe('StepRecorder.run', () => {
  it('records and announces the label with registered values replaced', async () => {
    const ledger = new SecretLedger([['token', 'tok-9f3a']]);
    const heard: StepProgress[] = [];
    const steps = new StepRecorder('attempt', {
      redact: ledger.redact,
      onProgress: (progress) => heard.push(progress),
    });
    await steps.run('app', 'app.open', '/reset?token=tok-9f3a', async () => {});
    expect(steps.all()[0]!.label).toBe('/reset?token=<secret:token>');
    const announced = heard.flatMap((progress) => ('label' in progress ? [progress.label] : []));
    expect(announced).toEqual(['/reset?token=<secret:token>', '/reset?token=<secret:token>']);
  });

  it('keeps the label as written without a redactor', async () => {
    const steps = new StepRecorder('attempt');
    await steps.run('agent', 'agent.act', 'use key tok-9f3a', async () => {});
    expect(steps.all()[0]!.label).toBe('use key tok-9f3a');
  });
});
