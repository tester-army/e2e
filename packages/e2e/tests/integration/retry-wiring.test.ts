/**
 * The retryOn wiring: config -> selection -> both retry loops.
 * An engine failure spends the retry budget only when the config says so.
 */

import { describe, expect, it } from 'vitest';
import type { RetryOnCategory } from '../../src/types.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

const infraOnce = `import { existsSync, writeFileSync } from 'node:fs';
import { EngineError } from 'e2e/engine';
import { test } from 'e2e';
test('fails once', async () => {
  const marker = new URL('./infra-failed-once', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, '');
    throw new EngineError('ENGINE_FAILURE', 'engine died once', { retryable: false });
  }
});
`;

const runWithRetryOn = (retryOn: readonly RetryOnCategory[]) =>
  runProject({ 'tests/infra-once.e2e.ts': infraOnce }, { config: { retries: 1, retryOn } });

describe('retryOn wiring', () => {
  it('retries an infrastructure failure when retryOn names it', async () => {
    const { outcome, project } = await runWithRetryOn(['test', 'infrastructure']);
    try {
      const result = resultByTitle(outcome, 'fails once');
      expect(result.status).toBe('flaky');
      expect(result.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
      expect(result.attempts[0]!.error?.category).toBe('infrastructure');
      expect(result.attempts[1]!.status).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('fails immediately on the default retryOn when the error is not test-category', async () => {
    const { outcome, project } = await runProject({ 'tests/infra-once.e2e.ts': infraOnce }, { config: { retries: 1 } });
    try {
      const result = resultByTitle(outcome, 'fails once');
      expect(result.status).toBe('failed');
      expect(result.attempts).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  });
});

describe('serial group retryOn wiring', () => {
  const serialSuite = `import { existsSync, writeFileSync } from 'node:fs';
import { EngineError } from 'e2e/engine';
import { test } from 'e2e';

test.describe('wizard', { serial: true }, () => {
  test('fails once', async () => {
    const marker = new URL('./infra-failed-once', import.meta.url);
    if (!existsSync(marker)) {
      writeFileSync(marker, '');
      throw new EngineError('ENGINE_FAILURE', 'engine died once', { retryable: false });
    }
  });
});
`;

  it('retries an infrastructure failure across serial-group attempts', async () => {
    const { outcome, project } = await runProject(
      { 'tests/wizard.e2e.ts': serialSuite },
      { config: { retries: 1, retryOn: ['test', 'infrastructure'] } },
    );
    try {
      const group = outcome.report.run.serialGroups![0]!;
      expect(group.attempts).toHaveLength(2);
      expect(group.attempts[0]!.status).toBe('failed');
      expect(group.attempts[1]!.status).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('does not retry an infrastructure failure when retryOn does not name it', async () => {
    const { outcome, project } = await runProject(
      { 'tests/wizard.e2e.ts': serialSuite },
      { config: { retries: 1 } },
    );
    try {
      const group = outcome.report.run.serialGroups![0]!;
      expect(group.attempts).toHaveLength(1);
      expect(group.attempts[0]!.status).toBe('failed');
    } finally {
      project.cleanup();
    }
  });
});
