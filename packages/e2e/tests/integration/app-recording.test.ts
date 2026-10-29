/**
 * `app.startRecording` / `app.stopRecording` through the runner on the real
 * web engine: a span becomes a video under `recordings/` linked from its
 * step, a page replaced mid-span gives one video per page, a span left
 * running is kept at the attempt's end, and a span is refused while the
 * test's video records, which still records as before.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { expect, test } from 'e2e';

test('records one span', async ({ app }) => {
  await app.open();
  await app.startRecording({ name: 'span' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const videos = await app.stopRecording();
  expect(videos).toHaveLength(1);
  expect(videos[0].path.endsWith('recordings/001-span.webm')).toBe(true);
});

test('one video per page', async ({ app }) => {
  await app.open();
  await app.startRecording({ name: 'restart' });
  await app.restart();
  const videos = await app.stopRecording();
  expect(videos.map((video) => video.path.split('/').at(-1))).toEqual(['001-restart.webm', '001-restart-part2.webm']);
});

test('left running', async ({ app }) => {
  await app.open();
  await app.startRecording();
});

test('refused while the video records', { video: 'on' }, async ({ app }) => {
  await app.open();
  const refusal = await app.startRecording().then(() => undefined, (error) => error.code);
  expect(refusal).toBe('UNSUPPORTED_CAPABILITY');
});
`;

describe('app recordings', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject({ 'tests/suite.e2e.ts': SUITE }, { appUrl: app.url, config: { cache: 'off', video: 'off' } }));
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  /** The video artifacts of a test's one attempt, with the steps that link them. */
  const videosOf = (title: string) => {
    const result = resultByTitle(outcome, title);
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    const attempt = result.attempts[0]!;
    expect(attempt.cleanup).toBe('complete');
    return attempt.artifacts
      .filter((artifact) => artifact.kind === 'video')
      .map((artifact) => ({
        path: artifact.path!,
        step: attempt.steps.find((step) => step.artifacts.includes(artifact.id))?.api,
      }));
  };

  it('records a span into recordings/ and links it from the stop step', () => {
    const videos = videosOf('records one span');
    expect(videos).toEqual([{ path: expect.stringMatching(/recordings\/001-span\.webm$/), step: 'app.stopRecording' }]);
    const file = path.join(project.dir, '.e2e', 'results', videos[0]!.path);
    expect(existsSync(file) && statSync(file).size).toBeGreaterThan(0);
  });

  it('returns one video per page when the page is replaced mid-span', () => {
    expect(videosOf('one video per page').map((video) => path.basename(video.path))).toEqual(['001-restart.webm', '001-restart-part2.webm']);
  });

  it('keeps a span left running when the attempt ends', () => {
    expect(videosOf('left running')).toEqual([{ path: expect.stringMatching(/recordings\/001-recording\.webm$/), step: undefined }]);
  });

  it("refuses a span while the test's video records, and keeps that video", () => {
    expect(videosOf('refused while the video records')).toEqual([{ path: expect.stringMatching(/video\/video\.webm$/), step: undefined }]);
  });
});
