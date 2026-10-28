/**
 * `screen.tree()` in a real run: a secret the screen shows reads as its
 * placeholder, as it does in the trace's screen at failure.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const TOKEN = 'tree-token-42';

const SUITE = `import { test } from 'e2e';

test('reads the tree', async ({ app, screen }) => {
  await app.open();
  const tree = await screen.tree();
  if (tree.includes('tree-' + 'token-42')) throw new Error('the tree shows the secret');
  if (!tree.includes('Token <secret:apiToken>')) throw new Error('no placeholder in: ' + tree);
});
`;

describe('screen.tree', () => {
  let project: FixtureProject | undefined;
  afterEach(() => project?.cleanup());

  it('redacts the secrets the run knows', async () => {
    const fake = createFakeEngine({ tree: { ref: { id: 'root', revision: '' }, role: 'root', name: '', children: [{ ref: { id: 'label', revision: '' }, role: 'text', name: `Token ${TOKEN}` }] } });
    const run = await runProject(
      { 'tests/tree.e2e.ts': SUITE },
      { config: { targets: [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }], secrets: { apiToken: TOKEN } } },
    );
    project = run.project;
    const result = resultByTitle(run.outcome, 'reads the tree');
    expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
  });
});
