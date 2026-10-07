/**
 * What each step was given lands on the report as `argument`: typed text,
 * keys, expected values, and a secret by name only. Input recorded in clear
 * only when the node it went to was read, is not secure, and takes it itself.
 */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/contract.ts';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject } from '../helpers/run-project.ts';

const PASSWORD = 'hunter2-argument-secret';

/** One secure textbox the fake engine's locate and read both resolve. */
const SECURE_TREE: SemanticNode = {
  ref: { id: 'root', revision: '' },
  role: 'root',
  children: [{ ref: { id: 'pw', revision: '' }, role: 'textbox', name: 'Password', states: { hidden: false, secure: true } }],
};

/** A plain textbox with a box, the field the recorded steps type into. */
const TEXTBOX: SemanticNode = { ref: { id: 'name', revision: '' }, role: 'textbox', name: 'Username', states: { hidden: false }, rect: { x: 10, y: 20, width: 150, height: 24 } };

/** A label the locator matches, which is not the password field it hands a fill on to. */
const LABEL_TREE: SemanticNode = {
  ref: { id: 'root', revision: '' },
  role: 'root',
  children: [
    { ref: { id: 'label', revision: '' }, role: 'generic', name: 'Password', states: { hidden: false } },
    { ref: { id: 'pw', revision: '' }, role: 'textbox', name: 'Password', states: { hidden: false, secure: true } },
  ],
};

/** Runs `suite` on a fake engine whose every locator resolves to `node`, and returns the last attempt's steps. */
async function stepsOf(suite: string, node: SemanticNode, tree: SemanticNode = { ref: { id: 'root', revision: '' }, role: 'root', children: [node] }) {
  const fake = createFakeEngine({ artifacts: true, tree, locate: async () => [node] });
  const config = { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }] } as E2EConfig;
  const { outcome, project } = await runProject({ 'tests/steps.e2e.ts': suite }, { appUrl: FAKE_APP_URL, config });
  try {
    assertValidReport(outcome.report);
    return { steps: outcome.report.run.results[0]!.attempts.at(-1)!.steps, text: JSON.stringify(outcome.report) };
  } finally {
    project.cleanup();
  }
}

const SECURE_TYPED = `import { test } from 'e2e';

test('types plain text into a password field', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').fill('marker-plain-into-secure');
});
`;

const SUITE = `import { test, credentials, expect } from 'e2e';

test('records arguments', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Username').fill('ada');
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await screen.getByLabel('Username').press('Enter');
  await expect(screen.getByRole('button')).toHaveCount(1);
  await expect(screen.getByRole('button')).not.toHaveCount(2);
});
`;

describe('step argument', () => {
  it(
    'records the typed text, the key, and the expected value, and a secret by its name',
    async () => {
      const fake = createFakeEngine({ artifacts: true, tree: { ref: { id: 'root', revision: '' }, role: 'root', children: [TEXTBOX] }, locate: async () => [TEXTBOX] });
      const config = {
        targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }],
        credentials: { member: { username: 'ada', password: PASSWORD } },
      } as E2EConfig;
      const { outcome, project } = await runProject({ 'tests/args.e2e.ts': SUITE }, { appUrl: FAKE_APP_URL, config });
      try {
        assertValidReport(outcome.report);
        const steps = outcome.report.run.results[0]!.attempts.at(-1)!.steps;
        expect(steps.map((step) => [step.api, step.argument])).toEqual([
          ['app.open', undefined],
          ['locator.fill', '"ada"'],
          ['locator.fill', '<secret:member.password>'],
          ['locator.press', 'Enter'],
          ['expect.toHaveCount', expect.stringContaining('1')],
          ['expect.not.toHaveCount', expect.stringMatching(/^not .*2/)],
        ]);
        expect(JSON.stringify(outcome.report)).not.toContain(PASSWORD);
        // The secret fill records where it acted like any other fill: the box is not secret.
        expect(steps[2]!.target).toEqual({ box: { x: 10, y: 20, width: 150, height: 24 } });
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'withholds plain text typed into a secure field: the field, not the argument type, decides',
    async () => {
      const fake = createFakeEngine({ artifacts: true, tree: SECURE_TREE, locate: async () => [SECURE_TREE.children![0]!] });
      const config = { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }] } as E2EConfig;
      const { outcome, project } = await runProject({ 'tests/secure.e2e.ts': SECURE_TYPED }, { appUrl: FAKE_APP_URL, config });
      try {
        const fill = outcome.report.run.results[0]!.attempts.at(-1)!.steps.find((step) => step.api === 'locator.fill')!;
        expect(fill.status).toBe('passed');
        expect(fill.argument).toBe('<withheld>');
        expect(JSON.stringify(outcome.report)).not.toContain('marker-plain-into-secure');
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'withholds the expected value of an assertion that reads a secure field',
    async () => {
      const fake = createFakeEngine({ artifacts: true, tree: SECURE_TREE, locate: async () => [SECURE_TREE.children![0]!] });
      const suite = `import { test, expect } from 'e2e';

test('asserts on a password field', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByLabel('Password')).toHaveValue('marker-expected-secret', { timeout: 200 });
});
`;
      const config = { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }] } as E2EConfig;
      const { outcome, project } = await runProject({ 'tests/secure-assert.e2e.ts': suite }, { appUrl: FAKE_APP_URL, config });
      try {
        const assertion = outcome.report.run.results[0]!.attempts.at(-1)!.steps.find((entry) => entry.api === 'expect.toHaveValue')!;
        expect(assertion.error?.code).toBe('POLICY_DENIED');
        expect(assertion.argument).toBe('<withheld>');
        expect(JSON.stringify(outcome.report)).not.toContain('marker-expected-secret');
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'withholds input an engine may hand on to another node: a fill and a key on a label, a key on a password field',
    async () => {
      const label = LABEL_TREE.children![0]!;
      const onLabel = await stepsOf(`import { test } from 'e2e';

test('acts on a label', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Password').fill('marker-label-fill');
  await screen.getByText('Password').press('Z');
});
`, label, LABEL_TREE);
      expect(onLabel.steps.map((step) => [step.api, step.status, step.argument])).toEqual([
        ['app.open', 'passed', undefined],
        ['locator.fill', 'passed', '<withheld>'],
        ['locator.press', 'passed', '<withheld>'],
      ]);
      expect(onLabel.text).not.toContain('marker-label-fill');

      const onSecure = await stepsOf(`import { test } from 'e2e';

test('presses keys into a password field', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').press('Q');
});
`, SECURE_TREE.children![0]!, SECURE_TREE);
      expect(onSecure.steps[1]).toMatchObject({ api: 'locator.press', status: 'passed', argument: '<withheld>' });
    },
    60_000,
  );

  it(
    'keeps at most 1024 bytes of an argument, and the report still validates',
    async () => {
      const { steps } = await stepsOf(`import { test } from 'e2e';

test('types a long text', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Username').fill('é'.repeat(2000));
});
`, TEXTBOX);
      const argument = steps[1]!.argument!;
      expect(Buffer.byteLength(argument, 'utf8')).toBeLessThanOrEqual(1024);
      expect(argument.startsWith('"éé')).toBe(true);
    },
    60_000,
  );
});

describe('step target', () => {
  it(
    'records the box of the node a locator action acted on, and the point of a positioned tap',
    async () => {
      const button: SemanticNode = { ref: { id: 'save', revision: '' }, role: 'button', name: 'Save', states: { hidden: false }, rect: { x: 40, y: 60, width: 120, height: 30 } };
      const fake = createFakeEngine({ artifacts: true, pointerActions: ['tap'], tree: { ref: { id: 'root', revision: '' }, role: 'root', children: [button] }, locate: async () => [button] });
      const suite = `import { test } from 'e2e';

test('acts on a box', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Save' }).tap();
  await screen.getByRole('button', { name: 'Save' }).tap({ position: { x: 5, y: 6 } });
});
`;
      const config = { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }] } as E2EConfig;
      const { outcome, project } = await runProject({ 'tests/box.e2e.ts': suite }, { appUrl: FAKE_APP_URL, config });
      try {
        assertValidReport(outcome.report);
        const steps = outcome.report.run.results[0]!.attempts.at(-1)!.steps;
        expect(steps.map((entry) => entry.status)).toEqual(['passed', 'passed', 'passed']);
        expect(steps[0]!.target).toBeUndefined();
        expect(steps[1]!.target).toEqual({ box: { x: 40, y: 60, width: 120, height: 30 } });
        expect(steps[2]!.target).toEqual({ box: { x: 40, y: 60, width: 120, height: 30 }, point: { x: 45, y: 66 } });
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );
});
