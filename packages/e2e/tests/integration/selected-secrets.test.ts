/**
 * A selection inside a plain field that holds a secret is withheld.
 * Through the real Playwright engine: a filled credential with 40 of its
 * characters selected in a text (not password) field reaches neither the
 * model, the failure screen, the report, nor any file under `.e2e` (the
 * entries of the Playwright trace included), while the same selection over a
 * plain value is still shown, in the trace too.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/run/runner.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { contentsUnder, resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const SECRET = 'sel-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7uM';
/** The first 8 of the 40 characters the page selects: any longer piece contains it. */
const FRAGMENT = SECRET.slice(5, 13);
const PLAIN = 'plain-control-0123456789abcdefghijklmnopqrstuvwxyz';

const SUITE = `import { test, credentials } from 'e2e';

test('selects part of a secret in a plain field', async ({ app, agent, screen }) => {
  await app.open('/select-part');
  await screen.getByLabel('Token').fill(${JSON.stringify(PLAIN)});
  await agent.assert('part of the plain token is selected');
  await screen.getByLabel('Token').fill(credentials.user('member').password);
  await agent.assert('part of the secret token is selected');
  await screen.getByRole('button', { name: 'Not on this page' }).tap();
});
`;

describe('selections inside a field that holds a secret', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(() => judgment(true, 'part of the token is selected'));
    ({ outcome, project } = await runProject(
      { 'tests/select.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
          credentials: { member: { username: 'ada', password: SECRET } },
        },
      },
    ));
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('shows the selection over a plain value and withholds it over the secret in the model input', () => {
    const [plain, secret] = fakeCalls.map((call) => call.observation);
    expect(plain).toContain(`selection=${JSON.stringify(PLAIN.slice(5, 45))}`);
    expect(secret).toContain('value="<secret:member.password>"');
    expect(secret).not.toContain('selection=');
    expect(secret).not.toContain(FRAGMENT);
  });

  it('keeps the selected fragment out of the failure screen, the report, the trace, and every file under .e2e', () => {
    const attempt = resultByTitle(outcome, 'selects part of a secret in a plain field').attempts.at(-1)!;
    expect(attempt.error?.code).toBe('LOCATOR_NOT_FOUND');
    const screen = attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screen)!;
    const screenText = readFileSync(path.join(project.dir, '.e2e', 'artifacts', screen.path!), 'utf8');
    expect(screenText).toContain('value="<secret:member.password>"');
    expect(screenText).not.toContain(FRAGMENT);
    expect(JSON.stringify(outcome.report)).not.toContain(FRAGMENT);
    const contents = contentsUnder(path.join(project.dir, '.e2e'));
    for (const [file, text] of contents) expect(text.includes(FRAGMENT), file).toBe(false);
    // The trace was scanned inside, and the plain selection survived its rewrite.
    const trace = contents.filter(([file]) => file.includes('.zip!'));
    expect(trace.some(([, text]) => text.includes(PLAIN.slice(5, 45)))).toBe(true);
  });
});
