/**
 * `toHaveScreenshot` in a process where `@napi-rs/image` cannot load, as after
 * `npm install --omit=optional`: the call fails as the codec's absence, with a
 * screenshot stored or not, not as an unreadable baseline or a screen that
 * never settled, and nothing is written.
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { runProject, type RunOutcome } from '../helpers/run-project.ts';

// This file imports nothing that loads the addon, so no earlier test in the process has.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@napi-rs/image') throw new Error('Cannot find native binding. npm has a bug related to optional dependencies');
    return nextResolve(specifier, context);
  },
});
afterAll(() => hooks.deregister());

const SCREEN_TEST = `import { test, expect } from 'e2e';

test('home', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot('home.png', { timeout: 1000 });
});
`;

const SNAPSHOTS = 'tests/home.e2e.ts-snapshots';
const STORED = `${SNAPSHOTS}/home-fake-${process.platform}.png`;

/** A screen whose bytes are no PNG: a decode that got as far as reading them would fail differently. */
function config(): E2EConfig {
  const pixels = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 1, height: 1, scale: 1 } as const;
  const fake = createFakeEngine({ fixtures: true, pixels: () => ({ pixels }) });
  return { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }] } as E2EConfig;
}

function attemptError(outcome: RunOutcome) {
  const result = outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === 'home');
  if (result === undefined) throw new Error('no reported result titled home');
  return result.attempts.at(-1)!.error;
}

describe('toHaveScreenshot without the @napi-rs/image binding', () => {
  it(
    'fails as IMAGE_CODEC_UNAVAILABLE, not as an unreadable stored screenshot',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/home.e2e.ts': SCREEN_TEST, [STORED]: 'a screenshot some other machine took' },
        { appUrl: FAKE_APP_URL, config: config() },
      );
      try {
        const error = attemptError(outcome);
        expect(error?.code).toBe('IMAGE_CODEC_UNAVAILABLE');
        expect(error?.message).toContain(`@napi-rs/image-${process.platform}-${process.arch}`);
        expect(error?.message).not.toContain('could not read the stored screenshot');
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'fails the capture as IMAGE_CODEC_UNAVAILABLE when nothing is stored, and writes no screenshot',
    async () => {
      const { outcome, project } = await runProject({ 'tests/home.e2e.ts': SCREEN_TEST }, { appUrl: FAKE_APP_URL, config: config() });
      try {
        expect(attemptError(outcome)?.code).toBe('IMAGE_CODEC_UNAVAILABLE');
        expect(existsSync(path.join(project.dir, SNAPSHOTS))).toBe(false);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );
});
