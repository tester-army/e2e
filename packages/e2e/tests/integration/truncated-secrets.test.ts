/**
 * A secret the web engine's observation limits cut short is still redacted.
 * Through the real Playwright engine: a filled credential echoed after filler
 * so the text (512) and name (256) limits keep all but its last character
 * reaches neither the model, the failure screen, the report, nor any file
 * under `.e2e` (the entries of the Playwright trace included), while a plain value placed the same way is still cut and
 * shown as it is.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/run/runner.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { contentsUnder, resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const SECRET = 'cut-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7uM';
/** The shortest leading part checked for: any longer one contains it. */
const FRAGMENT = SECRET.slice(0, 8);
/** What the control paragraph keeps once the text limit cuts it. */
const CONTROL_KEPT = 'plain-control-'.repeat(5).slice(0, 59);

const SUITE = `import { test, credentials } from 'e2e';

test('echoes a secret across the observation limits', async ({ app, agent, screen }) => {
  await app.open('/echo-cut');
  await screen.getByLabel('Source').fill(credentials.user('member').password);
  await agent.assert('the echo is on screen');
  await screen.getByRole('button', { name: 'Not on this page' }).tap();
});
`;

describe('secrets cut short by observation limits', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(() => judgment(true, 'the echo is shown'));
    ({ outcome, project } = await runProject(
      { 'tests/cut.e2e.ts': SUITE },
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

  it('keeps the cut fragment out of the model input and still cuts a plain value', () => {
    const observation = fakeCalls.map((call) => call.observation).join('\n');
    expect(observation).toContain(`${CONTROL_KEPT}"`);
    expect(observation).not.toContain(FRAGMENT);
    // The echoed text and the button's name each end in the marker where the cut value stood.
    expect(observation.match(/<secret:member>"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the cut fragment out of the failure screen, the report, the trace, and every file under .e2e', () => {
    const attempt = resultByTitle(outcome, 'echoes a secret across the observation limits').attempts.at(-1)!;
    expect(attempt.error?.code).toBe('LOCATOR_NOT_FOUND');
    const screen = attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screen)!;
    const screenText = readFileSync(path.join(project.dir, '.e2e', 'artifacts', screen.path!), 'utf8');
    expect(screenText).toContain(`${CONTROL_KEPT}"`);
    expect(screenText).not.toContain(FRAGMENT);
    expect(JSON.stringify(outcome.report)).not.toContain(FRAGMENT);
    const contents = contentsUnder(path.join(project.dir, '.e2e'));
    for (const [file, text] of contents) expect(text.includes(FRAGMENT), file).toBe(false);
    // The trace was scanned inside, and its plain text survived the rewrite.
    const trace = contents.filter(([file]) => file.includes('.zip!'));
    expect(trace.some(([, text]) => text.includes(CONTROL_KEPT))).toBe(true);
    // The same rewrite dropped the screencast of the tainted viewport.
    expect(trace.filter(([file]) => file.includes('.zip!screencast/'))).toEqual([]);
    expect(trace.some(([, text]) => text.includes('"screencast-frame"'))).toBe(false);
  });
});
