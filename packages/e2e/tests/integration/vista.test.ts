import { describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject } from '../helpers/run-project.ts';

describe('app.vista', () => {
  it('registers the named checkpoint and rejects invalid names before capture', async () => {
    const fake = createFakeEngine({ artifacts: true });
    const { outcome, project } = await runProject({ 'tests/vista.e2e.ts': `
import { test, expect } from 'e2e';
test('checkpoints', async ({ app }) => {
  await app.open('/');
  for (const name of ['', '  ', 'x'.repeat(201), 'x\\ny', 42, undefined]) {
    const error = await app.vista(name as string).then(() => undefined, (error: { code?: string }) => error.code);
    expect(error).toBe('INVALID_ARGUMENT');
  }
  expect(await app.vista('cart-ready')).toBe('screenshots/fake.png');
});
` }, { config: engineConfig(fake.engine) });
    try {
      expect(outcome.status).toBe('passed');
      assertValidReport(outcome.report);
      const attempt = outcome.report.run.results[0]!.attempts[0]!;
      const checkpoint = attempt.steps.find((step) => step.api === 'app.vista')!;
      expect(checkpoint).toMatchObject({ label: 'cart-ready', status: 'passed' });
      expect(attempt.artifacts.find((artifact) => checkpoint.artifacts.includes(artifact.id))).toMatchObject({ kind: 'screenshot', redaction: 'complete' });
      expect(fake.operations.filter((op) => op.method.startsWith('artifacts.screenshot('))).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  });

  it('requires the engine screenshot capability', async () => {
    const fake = createFakeEngine();
    const { outcome, project } = await runProject({ 'tests/vista.e2e.ts': `
import { test } from 'e2e';
test('no capture', async ({ app }) => { await app.vista('cart'); });
` }, { config: engineConfig(fake.engine) });
    try {
      expect(outcome.report.run.results[0]!.attempts[0]!.error?.code).toBe('UNSUPPORTED_CAPABILITY');
    } finally {
      project.cleanup();
    }
  });
});
