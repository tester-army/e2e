/**
 * `agent.act({ onAction })` end to end: the hook runs after each action on
 * the settled screen, for model-chosen and replayed actions alike; a throw
 * from it fails the step without touching the step's recording; and a
 * verification inside it never confirms the step it runs in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { writeFileSync } from 'node:fs';
import { readEntries } from '../helpers/trace-cache.ts';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';

const TITLE = 'screenshots every action';

const SUITE = `import { test, expect } from 'e2e';

test(${JSON.stringify(TITLE)}, async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice', {
    onAction: async ({ index, action, source, summary }) => {
      await app.screenshot(\`\${index} \${source} \${action}: \${summary}\`);
    },
  });
  await expect(screen.getByRole('status')).toHaveText('2');
});
`;

const IN_HOOK_CHECK_SUITE = `import { test, expect } from 'e2e';

test('checks only inside the hook', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice', {
    onAction: async ({ index }) => {
      await expect(screen.getByRole('status')).toHaveText(String(index));
    },
  });
});
`;

const THROW_AFTER_HAND_OFF_SUITE = `import { test, expect } from 'e2e';

test('throws after a hand-off', async ({ app, agent, screen }) => {
  await app.open();
  let replayed = false;
  await agent.act('increment the counter twice', {
    onAction: ({ source }) => {
      if (source === 'replay') replayed = true;
      else if (replayed) throw new Error('hook broke after the hand-off');
    },
  });
  await expect(screen.getByRole('status')).toHaveText('2');
});
`;

const DELAYED_SUITE = `import { test } from 'e2e';

test('the hook sees a change that lands after the tap', async ({ app, agent, screen }) => {
  await app.open('/delayed');
  await agent.act('continue to the second view', {
    onAction: async () => {
      const arrived = await screen.getByRole('heading', { name: 'Second view' }).isVisible();
      await app.screenshot(arrived ? 'arrived' : 'not yet');
    },
  });
});
`;

const TOOL_SUITE = `import { test } from 'e2e';

test('a mutating tool reaches the hook', async ({ app, agent }) => {
  await app.open();
  await agent.act('seed the data', {
    onAction: ({ index, action, summary }) => app.screenshot(\`\${index} \${action}: \${summary}\`),
  });
});
`;

const THROWING_SUITE = `import { test } from 'e2e';

test('a throwing hook fails the step', async ({ app, agent }) => {
  await app.open();
  await agent.act('increment the counter twice', {
    onAction: () => {
      throw new Error('hook broke');
    },
  });
});
`;

interface ExecutorRecord {
  calls: number;
}

/** Taps Increment until it has tapped twice, resuming after any replayed prefix. No AI SDK. */
function twoTapExecutor(record: ExecutorRecord = { calls: 0 }): StepExecutor {
  return {
    name: 'two-tap-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      for (let tap = context.replayedPrefix?.replayedActions.length ?? 0; tap < 2; tap += 1) {
        const observation = await context.observe();
        await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/) });
      }
      return { status: 'passed' as const, summary: 'tapped Increment twice' };
    },
  };
}

/** Taps Continue once and passes. */
const continueExecutor: StepExecutor = {
  name: 'continue-executor',
  async runStep(context: StepExecutorContext) {
    const observation = await context.observe();
    await context.actions.tap({ id: nodeIdFor(observation.text, /button "Continue"/) });
    return { status: 'passed' as const, summary: 'tapped Continue' };
  },
};

/** Runs one mutating project tool and passes. */
const toolExecutor: StepExecutor = {
  name: 'tool-executor',
  async runStep(context: StepExecutorContext) {
    await context.budgets.runTool({ name: 'seed', mutates: true }, async () => undefined);
    return { status: 'passed' as const, summary: 'seeded' };
  },
};

/** The labels of the `app.screenshot` steps the hook took, in order. */
function screenshotLabels(outcome: RunOutcome, title: string): string[] {
  const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
  return attempt.steps.filter((step) => step.api === 'app.screenshot').map((step) => step.label);
}

/**
 * Runs one suite twice against the read-write cache with the two-tap
 * executor, recording and then replaying; `between` edits the recording
 * before the replay.
 */
async function recordThenReplay(app: FixtureApp, suite: string, between?: (project: FixtureProject) => void): Promise<{
  project: FixtureProject;
  recorded: RunOutcome;
  replayed: RunOutcome;
  second: ExecutorRecord;
}> {
  const project = createProject({ 'tests/act.e2e.ts': suite });
  const options = (record: ExecutorRecord) => ({
    appUrl: app.url,
    config: {
      tests: 'tests/**/*.e2e.ts',
      agents: { default: { executor: twoTapExecutor(record) } },
      cache: 'read-write' as const,
    },
  });
  const recorded = await runExisting(project, options({ calls: 0 }));
  between?.(project);
  const second: ExecutorRecord = { calls: 0 };
  const replayed = await runExisting(project, options(second));
  return { project, recorded, replayed, second };
}

describe('agent.act onAction', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('runs after each model action, then for each replayed one, marked as the replay', async () => {
    const { project, recorded, replayed, second } = await recordThenReplay(app, SUITE);
    try {
      expect(resultByTitle(recorded, TITLE).status).toBe('passed');
      expect(screenshotLabels(recorded, TITLE)).toEqual([
        expect.stringMatching(/^1 model tap: /),
        expect.stringMatching(/^2 model tap: /),
      ]);
      const attempt = resultByTitle(recorded, TITLE).attempts.at(-1)!;
      for (const step of attempt.steps.filter((candidate) => candidate.api === 'app.screenshot')) {
        expect(step.artifacts).toHaveLength(1);
      }
      expect(resultByTitle(replayed, TITLE).status).toBe('passed');
      expect(second.calls).toBe(0);
      expect(screenshotLabels(replayed, TITLE)).toEqual([
        expect.stringMatching(/^1 replay tap: /),
        expect.stringMatching(/^2 replay tap: /),
      ]);
    } finally {
      project.cleanup();
    }
  }, 240_000);

  it('never confirms the step it runs in with a check of its own', async () => {
    const { project, recorded, replayed, second } = await recordThenReplay(app, IN_HOOK_CHECK_SUITE);
    try {
      expect(resultByTitle(recorded, 'checks only inside the hook').status).toBe('passed');
      expect(resultByTitle(replayed, 'checks only inside the hook').status).toBe('passed');
      expect(readEntries(project)).toEqual([]);
      expect(second.calls).toBe(1);
    } finally {
      project.cleanup();
    }
  }, 240_000);

  it('keeps the recording when it throws after a replay handed the step over', async () => {
    let recording = '';
    // The second recorded tap no longer finds its button: the replay taps
    // once and hands the step to the executor, whose tap the hook rejects.
    const { project, replayed } = await recordThenReplay(app, THROW_AFTER_HAND_OFF_SUITE, (recorded) => {
      const entries = readEntries(recorded);
      expect(entries).toHaveLength(1);
      const { file, entry } = entries[0]!;
      const [first, second] = entry.payload.actions;
      if (first === undefined || second?.name !== 'tap') throw new Error(`expected two taps, got ${JSON.stringify(entry.payload.actions)}`);
      const payload = { ...entry.payload, actions: [first, { ...second, target: { ...second.target, name: 'No Such Button' } }] };
      recording = JSON.stringify({ ...entry, payload }, null, 2);
      writeFileSync(file, recording, 'utf8');
    });
    try {
      const attempt = resultByTitle(replayed, 'throws after a hand-off').attempts.at(-1)!;
      expect(attempt.error?.message).toContain('agent.act onAction failed: hook broke after the hand-off');
      expect(readEntries(project).map(({ entry }) => JSON.stringify(entry, null, 2))).toEqual([recording]);
    } finally {
      project.cleanup();
    }
  }, 240_000);

  it('waits for the screen the action left before calling the hook', async () => {
    const { outcome, project } = await runProject(
      { 'tests/delayed.e2e.ts': DELAYED_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: continueExecutor } } } },
    );
    try {
      expect(screenshotLabels(outcome, 'the hook sees a change that lands after the tap')).toEqual(['arrived']);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('runs after a mutating project tool', async () => {
    const { outcome, project } = await runProject(
      { 'tests/tool.e2e.ts': TOOL_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: toolExecutor } } } },
    );
    try {
      expect(screenshotLabels(outcome, 'a mutating tool reaches the hook')).toEqual(['1 tool:seed: ran seed']);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('fails the step with the hook error after the first action', async () => {
    const { outcome, project } = await runProject(
      { 'tests/throwing.e2e.ts': THROWING_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: twoTapExecutor() } } } },
    );
    try {
      const attempt = resultByTitle(outcome, 'a throwing hook fails the step').attempts.at(-1)!;
      expect(attempt.error?.code).toBe('ACTION_FAILED');
      expect(attempt.error?.message).toContain('agent.act onAction failed: hook broke');
      const step = attempt.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.status).toBe('failed');
      expect(step.metrics?.actionSteps).toBe(1);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});
