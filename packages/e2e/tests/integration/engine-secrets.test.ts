/**
 * A secret an engine option holds. `e2e.config.ts` calls `secrets.get()`
 * while it evaluates, in the runner and again in every worker, before any
 * run exists; the handle is a reference by name that the web engine resolves
 * when an attempt starts, to answer a basic-auth challenge. The value comes
 * from a provider, so nothing registered it up front: the attempt's
 * resolution alone is what makes the page's echo of it redacted in the
 * failure message, the report, and every file the reporters write. The engine also
 * registers the base64 credential the `Authorization` header carries, which
 * a page echoing its request headers shows instead of the password. The
 * protection is text only: text downloads are rewritten too, but
 * screenshots and the model's pixels are kept, as with no secret. Over the fake engine: only a secret the engine
 * declared resolves.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from '../../src/index.ts';
import type { RunOutcome } from '../../src/run/runner.ts';
import { secrets } from '../../src/secrets.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { contentsUnder, resultByTitle, runProject, runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';

const PASSWORD = 'basic-Pa55-7Qz';
/** What the `Authorization: Basic` header carries for ada and the password, which the page echoes. */
const CREDENTIAL = Buffer.from(`ada:${PASSWORD}`).toString('base64');

const CONFIG = `import type { E2EConfig } from 'e2e';
import { secrets } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [
    {
      name: 'web',
      engine: web({ basicAuth: { username: 'ada', password: secrets.get('stagingPassword') } }),
      app: { url: process.env.APP_URL! },
    },
  ],
  workers: 2,
  reporters: ['markdown', 'junit'],
  secrets: { stagingPassword: () => ${JSON.stringify(PASSWORD)} },
} satisfies E2EConfig;
`;

const SUITE = `import { test, expect } from 'e2e';

test('signs in through basic auth', async ({ app, screen }) => {
  await app.open('/basic-auth');
  await expect(screen.getByRole('heading', { name: 'Signed in as ada' })).toBeVisible();
});

test('fails on the echoed password', async ({ app, screen }) => {
  await app.open('/basic-auth');
  await expect(screen.getByTestId('echo')).toHaveText('something else', { timeout: 500 });
});

test('fails on the echoed Authorization header', async ({ app, screen }) => {
  await app.open('/basic-auth');
  await expect(screen.getByTestId('header')).toHaveText('something else', { timeout: 500 });
});

test('downloads the echoed headers', async ({ app, browser }) => {
  await app.open('/basic-auth');
  await browser.waitForDownload(() => browser.locator('a[download]').tap());
});

test('takes a screenshot of the page, an engine-held secret tainting no pixels', async ({ app }) => {
  await app.open('/basic-auth');
  await app.screenshot('echo');
});
`;

describe('a secret in an engine option', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProjectWithConfigFile(
      { 'tests/basic-auth.e2e.ts': SUITE },
      { appUrl: app.url, configSource: CONFIG },
    ));
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('answers the challenge with the resolved value', () => {
    expect(resultByTitle(outcome, 'signs in through basic auth').status, JSON.stringify(outcome.report.run.errors)).toBe('passed');
  });

  it('redacts the value the page echoes from the failure, the report, and the reporters\' files', () => {
    const error = resultByTitle(outcome, 'fails on the echoed password').attempts[0]!.error!;
    expect(error.message).toContain('<secret:stagingPassword>');
    expect(JSON.stringify(outcome.report)).not.toContain(PASSWORD);
    const contents = contentsUnder(`${project.dir}/.e2e`);
    for (const [file, text] of contents) expect(text, file).not.toContain(PASSWORD);
  });

  it('redacts the base64 credential of the echoed header everywhere: failure, screen, trace pages, download', () => {
    const error = resultByTitle(outcome, 'fails on the echoed Authorization header').attempts[0]!.error!;
    expect(error.message).toContain('Basic <secret:stagingPassword>');
    expect(JSON.stringify(outcome.report)).not.toContain(CREDENTIAL);
    const contents = contentsUnder(`${project.dir}/.e2e`);
    for (const written of ['/screen-at-failure.txt', '/trace.md', '/downloads/']) {
      expect(contents.some(([name]) => name.includes(written)), written).toBe(true);
    }
    for (const [file, text] of contents) expect(text, file).not.toContain(CREDENTIAL);
  });

  it('protects the secret as text only: screenshots are kept, the text download rewritten', () => {
    const shot = resultByTitle(outcome, 'takes a screenshot of the page, an engine-held secret tainting no pixels');
    expect(shot.status, JSON.stringify(shot.attempts[0]?.error)).toBe('passed');
    const failure = resultByTitle(outcome, 'fails on the echoed Authorization header').attempts[0]!;
    expect(failure.artifacts.filter((artifact) => artifact.kind === 'screenshot')).toHaveLength(1);
    const download = resultByTitle(outcome, 'downloads the echoed headers').attempts[0]!.artifacts.find((artifact) => artifact.kind === 'download')!;
    expect(download.redaction).toBe('complete');
  });
});

describe('what the model sees of an engine-held secret', () => {
  it('reads the redacted tree, never the credential, with its pixels as with no secret', async () => {
    const app = await startFixtureApp();
    const model = installFakeModel(() => judgment(true, 'it does'));
    const { outcome, project } = await runProject(
      {
        'tests/judge.e2e.ts': `import { test } from 'e2e';

test('judges the echo with vision on', async ({ app, agent }) => {
  await app.open('/basic-auth');
  await agent.assert('the page shows a Basic credential', { vision: true });
});
`,
      },
      {
        appUrl: app.url,
        config: {
          targets: [
            {
              name: 'web',
              engine: web({ basicAuth: { username: 'ada', password: secrets.get('stagingPassword') as never } }) as never,
              app: { url: app.url },
            },
          ],
          agents: { default: { model } },
          secrets: { stagingPassword: () => PASSWORD },
        },
      },
    );
    try {
      const result = resultByTitle(outcome, 'judges the echo with vision on');
      expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
      const judged = fakeCalls.find((call) => call.instruction === 'the page shows a Basic credential')!;
      expect(judged.observation).toContain('Basic <secret:stagingPassword>');
      expect(judged.prompt).not.toContain(CREDENTIAL);
      expect(judged.prompt).not.toContain(PASSWORD);
      expect(judged.images).toHaveLength(1);
      const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'agent.assert')!;
      expect(step.visionDegraded).toBeUndefined();
      expect(step.visionInput).toBe(true);
    } finally {
      project.cleanup();
      await app.close();
    }
  }, 120_000);
});

describe('resolving an engine secret', () => {
  it('hands the engine a declared value and refuses one it did not declare', async () => {
    const resolved: string[] = [];
    const fake = createFakeEngine({
      secrets: [secrets.get('declared')],
      async onStartAttempt(context, attemptIndex) {
        resolved.push(await context.resolveSecret(secrets.get(attemptIndex === 0 ? 'declared' : 'undeclared')));
      },
    });
    const { outcome, project } = await runProject(
      {
        'tests/first.e2e.ts': `import { test } from 'e2e';\ntest('first', async () => {});\n`,
        'tests/second.e2e.ts': `import { test } from 'e2e';\ntest('second', async () => {});\n`,
      },
      {
        appUrl: FAKE_APP_URL,
        config: {
          targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }],
          workers: 1,
          secrets: { declared: () => 'declared-value', undeclared: 'undeclared-value' },
        } as Partial<E2EConfig>,
      },
    );
    try {
      expect(resolved).toEqual(['declared-value']);
      const refused = outcome.results.find((result) => result.status !== 'passed')!;
      expect(refused.attempts[0]!.error).toMatchObject({
        code: 'SECRET_UNAVAILABLE',
        message: expect.stringContaining('asked for secret "undeclared", which it did not declare in its secrets'),
      });
      expect(outcome.results.filter((result) => result.status === 'passed')).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  });
});
