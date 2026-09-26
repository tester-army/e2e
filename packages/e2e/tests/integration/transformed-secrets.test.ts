/**
 * A secret the page shows transformed is still a secret. Through the real
 * browser engine: a token echoed under CSS `text-transform` and a two-line
 * note echoed in a `<pre>` reach a failed `toHaveText` and the executor's
 * observation as the reader returns them, upper- or lower-cased, or with the
 * line break collapsed to a space. Neither form may survive in the model-bound
 * observation, the failure message, the report, or any file the reporters
 * write; the plain echo is the control, and matching the transformed text
 * still passes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/run/runner.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const TOKEN = 'Tok-9f3aC0DeB1e7';
const NOTE = 'first line 4417\nsecond line Qx';

/** Every form of the two values a reader or a transform can produce. */
const FORMS = [TOKEN, TOKEN.toUpperCase(), TOKEN.toLowerCase(), NOTE, NOTE.replace('\n', ' '), JSON.stringify(NOTE).slice(1, -1)];

const SUITE = `import { test, expect, secrets } from 'e2e';

async function fillBoth(app, screen) {
  await app.open('/echo');
  await screen.getByLabel('Token').fill(secrets.get('token'));
  await screen.getByLabel('Note').fill(secrets.get('note'));
}

for (const id of ['plain', 'upper', 'lower', 'note-echo']) {
  test('fails on the ' + id + ' echo', async ({ app, screen }) => {
    await fillBoth(app, screen);
    await expect(screen.getByTestId(id)).toHaveText('something else', { timeout: 500 });
  });
}

test('observes the echoes', async ({ app, screen, agent }) => {
  await fillBoth(app, screen);
  await agent.act('read the echoes');
});

test('matches the transformed text', async ({ app, screen }) => {
  await fillBoth(app, screen);
  await expect(screen.getByTestId('upper')).toHaveText(${JSON.stringify(TOKEN.toUpperCase())});
  await expect(screen.getByTestId('lower')).toHaveText(${JSON.stringify(TOKEN.toLowerCase())});
  await expect(screen.getByTestId('note-echo')).toHaveText(${JSON.stringify(NOTE.replace('\n', ' '))});
});
`;

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
}

describe('secrets shown transformed', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;
  const observed: string[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/echo.e2e.ts': SUITE });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json', 'markdown', 'junit'] as const,
        secrets: { token: TOKEN, note: NOTE },
        agents: {
          default: {
            executor: {
              name: 'observer',
              async runStep(context) {
                observed.push((await context.observe()).text);
                return { status: 'passed', summary: 'read' };
              },
            },
          },
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('shows the model each echo redacted, with no form of either value', () => {
    expect(observed).toHaveLength(1);
    const [text] = observed;
    expect(text).toContain('<secret:token>');
    expect(text).toContain('<secret:note>');
    for (const form of FORMS) expect(text).not.toContain(form);
  });

  it.each(['plain', 'upper', 'lower', 'note-echo'])('fails on the %s echo with the received text redacted', (id) => {
    const result = resultByTitle(outcome, `fails on the ${id} echo`);
    expect(result.status).toBe('failed');
    const message = result.attempts[0]!.error!.message;
    expect(message).toContain(id === 'note-echo' ? '<secret:note>' : '<secret:token>');
    for (const form of FORMS) expect(message).not.toContain(form);
  });

  it('matches the transformed text as the page shows it', () => {
    expect(resultByTitle(outcome, 'matches the transformed text').status).toBe('passed');
  });

  it('leaves no form of either value in the report or any file the reporters write', () => {
    const report = JSON.stringify(outcome.report);
    for (const form of FORMS) expect(report).not.toContain(form);
    const files = filesUnder(path.join(project.dir, '.e2e'));
    expect(files.some((file) => file.endsWith('.md'))).toBe(true);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const form of FORMS) expect(text, file).not.toContain(form);
    }
  });
});
