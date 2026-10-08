/**
 * `toHaveScreenshot` through the real runner over the fake engine, so what
 * is tested is the engine-neutral path: pixels from `observe`, scaled to the
 * viewport, cut to a locator's box, masked, compared against the PNG stored
 * beside the test file, and rewritten under `updateSnapshots`.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { EngineObserveOptions, ObservationPixels, SemanticNode } from '../../src/engine/index.ts';
import type { E2EConfig } from '../../src/index.ts';
import { engineFailure } from '../helpers/engine-runtime.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runExisting, runProject, type RunOutcome } from '../helpers/run-project.ts';

type Rgb = readonly [number, number, number];

const WIDTH = 1280;
const HEIGHT = 720;
const BUTTON = { x: 100, y: 50, width: 40, height: 20 };
const SUFFIX = `-fake-${process.platform}`;

const TREE: SemanticNode = {
  ref: { id: 'root', revision: '' },
  role: 'document',
  children: [
    { ref: { id: 'button', revision: '' }, role: 'button', name: 'Submit', rect: BUTTON, states: { hidden: false } },
    { ref: { id: 'clock', revision: '' }, role: 'text', name: 'Clock', testId: 'clock', rect: { x: 300, y: 10, width: 50, height: 10 }, states: { hidden: false } },
  ],
};

/** A screen of one background color with the button drawn in another, `scale` image pixels per viewport pixel. */
function screenPng(background: Rgb, button: Rgb, scale = 1): ObservationPixels {
  const width = WIDTH * scale;
  const height = HEIGHT * scale;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inButton =
        x >= BUTTON.x * scale && x < (BUTTON.x + BUTTON.width) * scale && y >= BUTTON.y * scale && y < (BUTTON.y + BUTTON.height) * scale;
      const color = inButton ? button : background;
      const at = (y * width + x) * 4;
      png.data[at] = color[0];
      png.data[at + 1] = color[1];
      png.data[at + 2] = color[2];
      png.data[at + 3] = 255;
    }
  }
  return { data: new Uint8Array(PNG.sync.write(png)), mediaType: 'image/png', width, height, scale };
}

const WHITE: Rgb = [255, 255, 255];
const BLUE: Rgb = [0, 0, 255];
const RED: Rgb = [255, 0, 0];

/** What a screen engine does beside showing its screen. */
interface ScreenEngineOptions {
  readonly tree?: SemanticNode;
  /** Runs before every observation: a wait, or a throw. */
  readonly observe?: () => void | Promise<void>;
}

/** A fake engine whose screen is `current()`, recording every observe option it was asked for. */
function screenEngine(
  current: () => ObservationPixels | undefined,
  { tree = TREE, observe }: ScreenEngineOptions = {},
): { fake: FakeEngineHandle; asked: EngineObserveOptions[] } {
  const asked: EngineObserveOptions[] = [];
  const fake = createFakeEngine({
    tree,
    fixtures: true,
    ...(observe === undefined ? {} : { observe }),
    locate: (expression) => {
      if (expression.kind === 'query' && expression.query.kind === 'role') return [tree.children![0]!];
      if (expression.kind === 'query' && expression.query.kind === 'testId') return [tree.children![1]!];
      return [];
    },
    pixels: (options) => {
      asked.push(options);
      const pixels = current();
      return pixels === undefined ? undefined : { pixels };
    },
  });
  return { fake, asked };
}

function fakeConfig(fake: FakeEngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
  return { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }], ...extra } as E2EConfig;
}

function attemptOf(outcome: RunOutcome, title: string) {
  const result = outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title);
  if (result === undefined) throw new Error(`no reported result titled ${title}`);
  return result.attempts.at(-1)!;
}

function readPng(file: string): PNG {
  return PNG.sync.read(readFileSync(file));
}

const SCREEN_TEST = `import { test, expect } from 'e2e';

test('home', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot('home.png', { timeout: 1000 });
});
`;

describe('toHaveScreenshot', () => {
  it(
    'writes a missing screenshot and fails, passes against it next run, fails with the stored, actual, and diff images once the screen changes, and rewrites it under updateSnapshots',
    async () => {
      let screen = screenPng(WHITE, BLUE);
      const { fake, asked } = screenEngine(() => screen);
      const options = { appUrl: FAKE_APP_URL, config: fakeConfig(fake) };
      const { outcome, project } = await runProject({ 'tests/home.e2e.ts': SCREEN_TEST }, options);
      try {
        const stored = path.join(project.dir, 'tests', 'home.e2e.ts-snapshots', `home${SUFFIX}.png`);
        const first = attemptOf(outcome, 'home');
        expect(first.error?.code).toBe('ASSERTION_FAILED');
        expect(first.error?.message).toContain(`no stored screenshot at tests/home.e2e.ts-snapshots/home${SUFFIX}.png`);
        expect(existsSync(stored)).toBe(true);
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.every((option) => option.comparable === true)).toBe(true);

        const second = await runExisting(project, options);
        expect(attemptOf(second, 'home').error).toBeUndefined();

        screen = screenPng(WHITE, RED);
        const third = await runExisting(project, options);
        assertValidReport(third.report);
        const attempt = attemptOf(third, 'home');
        expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', details: { expected: `tests/home.e2e.ts-snapshots/home${SUFFIX}.png` } });
        expect(attempt.error?.message).toContain(`${BUTTON.width * BUTTON.height} pixels`);
        const step = attempt.steps.find((candidate) => candidate.api === 'expect.toHaveScreenshot')!;
        const attached = attempt.artifacts.filter((artifact) => step.artifacts.includes(artifact.id));
        expect(attached.map((artifact) => path.posix.basename(artifact.path!))).toEqual(['home-diff.png', 'home-actual.png', 'home-expected.png']);
        // The message names each image where the user finds it, relative to the project.
        for (const [label, artifact] of [['diff', attached[0]], ['actual', attached[1]], ['expected', attached[2]]] as const) {
          expect(attempt.error?.message).toContain(`\n${label}: .e2e/results/${artifact!.path}`);
          expect(existsSync(path.join(project.dir, '.e2e', 'results', artifact!.path!))).toBe(true);
        }

        const updated = await runExisting(project, { ...options, runOptions: { updateSnapshots: true } });
        expect(attemptOf(updated, 'home').error).toBeUndefined();
        const rewritten = readPng(stored);
        const at = (BUTTON.y * WIDTH + BUTTON.x) * 4;
        expect([...rewritten.data.subarray(at, at + 3)]).toEqual([...RED]);
        expect(attemptOf(await runExisting(project, options), 'home').error).toBeUndefined();
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'keeps screenshots at one image pixel per viewport pixel, cuts a locator to its box, paints masks, and names an unnamed call after the test',
    async () => {
      const { fake } = screenEngine(() => screenPng(WHITE, BLUE, 2));
      const test = `import { test, expect } from 'e2e';

test('crops and masks', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot('full', { mask: [screen.getByTestId('clock')], maskColor: '#00ff00' });
  await expect(screen.getByRole('button')).toHaveScreenshot();
  await expect(screen.getByRole('button')).toHaveScreenshot();
});
`;
      const { project } = await runProject({ 'tests/crop.e2e.ts': test }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        const directory = path.join(project.dir, 'tests', 'crop.e2e.ts-snapshots');
        const full = readPng(path.join(directory, `full${SUFFIX}.png`));
        expect([full.width, full.height]).toEqual([WIDTH, HEIGHT]);
        const clock = (15 * WIDTH + 310) * 4;
        expect([...full.data.subarray(clock, clock + 3)]).toEqual([0, 255, 0]);
        // The first run stops at the first missing screenshot; two more write the button's two.
        await runExisting(project, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
        await runExisting(project, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
        for (const name of [`crops-and-masks-1${SUFFIX}.png`, `crops-and-masks-2${SUFFIX}.png`]) {
          const button = readPng(path.join(directory, name));
          expect([button.width, button.height]).toEqual([BUTTON.width, BUTTON.height]);
          expect([...button.data.subarray(0, 3)]).toEqual([...BLUE]);
        }
        const last = await runExisting(project, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
        expect(attemptOf(last, 'crops and masks').error).toBeUndefined();
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'tolerates the differences its options allow, and .not passes on a screen that differs',
    async () => {
      let screen = screenPng(WHITE, BLUE);
      const { fake } = screenEngine(() => screen);
      const test = `import { test, expect } from 'e2e';

test('tolerant', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot('home', { maxDiffPixels: 800, timeout: 1000 });
  await expect(screen).toHaveScreenshot('home', { maxDiffPixelRatio: 0.001, timeout: 1000 });
  await expect(screen).not.toHaveScreenshot('home', { timeout: 1000 });
});
`;
      const options = { appUrl: FAKE_APP_URL, config: fakeConfig(fake) };
      const { project } = await runProject({ 'tests/tolerant.e2e.ts': test }, options);
      try {
        screen = screenPng(WHITE, RED);
        const outcome = await runExisting(project, options);
        expect(attemptOf(outcome, 'tolerant').error).toBeUndefined();
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'fails on a screen that never holds still, with the last two screenshots and their diff attached',
    async () => {
      let frame = 0;
      const { fake } = screenEngine(() => screenPng(WHITE, (frame += 1) % 2 === 0 ? BLUE : RED));
      const { outcome, project } = await runProject({ 'tests/home.e2e.ts': SCREEN_TEST }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        const attempt = attemptOf(outcome, 'home');
        expect(attempt.error?.code).toBe('ASSERTION_FAILED');
        expect(attempt.error?.message).toContain('never held still');
        const names = attempt.artifacts.map((artifact) => path.posix.basename(artifact.path ?? ''));
        expect(names).toEqual(expect.arrayContaining(['home-previous.png', 'home-actual.png', 'home-diff.png']));
        expect(existsSync(path.join(project.dir, 'tests', 'home.e2e.ts-snapshots'))).toBe(false);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'keeps no screenshot when a secure field on screen went unmasked, or once a secret was filled',
    async () => {
      const secureTree: SemanticNode = {
        ...TREE,
        children: [...TREE.children!, { ref: { id: 'password', revision: '' }, role: 'textbox', name: 'Password', states: { secure: true, hidden: false } }],
      };
      const { fake } = screenEngine(() => screenPng(WHITE, BLUE), { tree: secureTree });
      const unmasked = await runProject({ 'tests/home.e2e.ts': SCREEN_TEST }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        expect(attemptOf(unmasked.outcome, 'home').error).toMatchObject({ category: 'configuration', code: 'POLICY_DENIED' });
        expect(existsSync(path.join(unmasked.project.dir, 'tests', 'home.e2e.ts-snapshots'))).toBe(false);
      } finally {
        unmasked.project.cleanup();
      }

      const { fake: plain } = screenEngine(() => screenPng(WHITE, BLUE));
      const filled = `import { test, expect, secrets } from 'e2e';

test('after a fill', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button').fill(secrets.get('token'));
  await expect(screen).toHaveScreenshot('home');
});
`;
      const afterFill = await runProject(
        { 'tests/fill.e2e.ts': filled },
        { appUrl: FAKE_APP_URL, config: fakeConfig(plain, { secrets: { token: 'a-very-secret-token' } }) },
      );
      try {
        expect(attemptOf(afterFill.outcome, 'after a fill').error).toMatchObject({ category: 'configuration', code: 'POLICY_DENIED' });
        expect(existsSync(path.join(afterFill.project.dir, 'tests', 'fill.e2e.ts-snapshots'))).toBe(false);
      } finally {
        afterFill.project.cleanup();
      }
    },
    60_000,
  );

  it(
    'reports the mismatch it saw when a later capture comes back without pixels, as a read the deadline cut short does',
    async () => {
      let captures = 0;
      let changed = false;
      const { fake } = screenEngine(() => {
        if (!changed) return screenPng(WHITE, BLUE);
        captures += 1;
        return captures === 1 ? screenPng(WHITE, RED) : undefined;
      });
      const options = { appUrl: FAKE_APP_URL, config: fakeConfig(fake) };
      const { project } = await runProject({ 'tests/home.e2e.ts': SCREEN_TEST }, options);
      try {
        changed = true;
        const attempt = attemptOf(await runExisting(project, options), 'home');
        expect(attempt.error?.message).toContain(`${BUTTON.width * BUTTON.height} pixels`);
        expect(attempt.artifacts.map((artifact) => path.posix.basename(artifact.path ?? ''))).toContain('home-diff.png');
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'writes a missing screenshot and passes under updateSnapshots',
    async () => {
      const { fake } = screenEngine(() => screenPng(WHITE, BLUE));
      const { outcome, project } = await runProject(
        { 'tests/home.e2e.ts': SCREEN_TEST },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake), runOptions: { updateSnapshots: true } },
      );
      try {
        expect(attemptOf(outcome, 'home').error).toBeUndefined();
        expect(existsSync(path.join(project.dir, 'tests', 'home.e2e.ts-snapshots', `home${SUFFIX}.png`))).toBe(true);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'never passes a retry against the screenshot its first attempt wrote, and in CI writes none into the project, attaching it under the path it belongs at',
    async () => {
      const { fake } = screenEngine(() => screenPng(WHITE, BLUE));
      const local = await runProject({ 'tests/home.e2e.ts': SCREEN_TEST }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake, { retries: 1 }) });
      try {
        const result = local.outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === 'home')!;
        expect(result.status).toBe('failed');
        expect(result.attempts.map((attempt) => attempt.error?.message)).toEqual([
          expect.stringContaining('wrote this run\'s there'),
          expect.stringContaining('written earlier in this run'),
        ]);
      } finally {
        local.project.cleanup();
      }

      const ci = await runProject(
        { 'tests/home.e2e.ts': SCREEN_TEST },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake, { retries: 1 }), runOptions: { env: { ...process.env, CI: '1' } } },
      );
      try {
        const result = ci.outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === 'home')!;
        expect(result.status).toBe('failed');
        expect(result.attempts).toHaveLength(2);
        expect(existsSync(path.join(ci.project.dir, 'tests', 'home.e2e.ts-snapshots'))).toBe(false);
        const attempt = result.attempts.at(-1)!;
        expect(attempt.error?.message).toContain('CI writes none');
        expect(attempt.error?.message).toContain(`\nactual: .e2e/results/${attempt.artifacts.find((artifact) => artifact.path?.includes('/snapshots/'))!.path}`);
        const kept = attempt.artifacts.find((artifact) => artifact.path?.endsWith(`snapshots/tests/home.e2e.ts-snapshots/home${SUFFIX}.png`));
        expect(kept).toBeDefined();
        expect(readPng(path.join(ci.project.dir, '.e2e', 'results', kept!.path!)).width).toBe(WIDTH);
      } finally {
        ci.project.cleanup();
      }
    },
    60_000,
  );

  it(
    'paints a mask at the right place inside a locator\'s box',
    async () => {
      const { fake } = screenEngine(() => screenPng(WHITE, BLUE));
      const test = `import { test, expect } from 'e2e';

test('masked button', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button')).toHaveScreenshot('button', { mask: [screen.getByRole('button')], maskColor: '#00ff00' });
});
`;
      const { project } = await runProject({ 'tests/mask.e2e.ts': test }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        const button = readPng(path.join(project.dir, 'tests', 'mask.e2e.ts-snapshots', `button${SUFFIX}.png`));
        expect([button.width, button.height]).toEqual([BUTTON.width, BUTTON.height]);
        expect([...button.data.subarray(0, 3)]).toEqual([0, 255, 0]);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'fails on a screen of another size, on a .not that still matches, and with one screenshot before the timeout; honors threshold',
    async () => {
      let screen = screenPng(WHITE, BLUE);
      let delayMs = 0;
      const { fake } = screenEngine(() => screen, { observe: () => new Promise((resolve) => setTimeout(resolve, delayMs)) });
      const test = `import { test, expect } from 'e2e';

test('size', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot('small', { timeout: 500 });
});

test('negated', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).not.toHaveScreenshot('home', { timeout: 500 });
});

test('threshold', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot('home', { timeout: 500 });
  await expect(screen).toHaveScreenshot('home', { threshold: 0, timeout: 500 });
});
`;
      const options = { appUrl: FAKE_APP_URL, config: fakeConfig(fake) };
      // The first run writes every screenshot; the small one is then replaced by one of another size.
      const { project } = await runProject({ 'tests/edges.e2e.ts': test }, options);
      try {
        const directory = path.join(project.dir, 'tests', 'edges.e2e.ts-snapshots');
        const small = new PNG({ width: 10, height: 10 });
        small.data.fill(255);
        writeFileSync(path.join(directory, `small${SUFFIX}.png`), PNG.sync.write(small));

        screen = screenPng(WHITE, [0, 0, 250]);
        const outcome = await runExisting(project, options);
        expect(attemptOf(outcome, 'size').error?.message).toContain(`a ${WIDTH}x${HEIGHT} screenshot where tests/edges.e2e.ts-snapshots/small${SUFFIX}.png is 10x10`);
        expect(attemptOf(outcome, 'negated').error?.message).toContain('the screen still matches');
        const threshold = attemptOf(outcome, 'threshold');
        expect(threshold.error?.message).toContain(`${BUTTON.width * BUTTON.height} pixels`);
        expect(threshold.steps.filter((step) => step.api === 'expect.toHaveScreenshot').map((step) => step.status)).toEqual(['passed', 'failed']);

        // One capture outlasts the whole 1 s budget.
        delayMs = 1_100;
        const late = await runProject({ 'tests/late.e2e.ts': SCREEN_TEST }, options);
        try {
          expect(attemptOf(late.outcome, 'home').error?.message).toContain('took 1 screenshot before the timeout');
        } finally {
          late.project.cleanup();
        }
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'reports the mismatch it saw when a later capture runs past the deadline and times out',
    async () => {
      let armed = false;
      let observations = 0;
      let screen = screenPng(WHITE, BLUE);
      const { fake } = screenEngine(() => screen, {
        observe: async () => {
          if (!armed) return;
          observations += 1;
          if (observations !== 2) return;
          // The second capture starts inside the 1 s budget and ends past it, as a slow engine's does.
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          throw engineFailure('OPERATION_TIMEOUT', 'the screenshot outlived its budget');
        },
      });
      const options = { appUrl: FAKE_APP_URL, config: fakeConfig(fake) };
      const { project } = await runProject({ 'tests/home.e2e.ts': SCREEN_TEST }, options);
      try {
        armed = true;
        screen = screenPng(WHITE, RED);
        const attempt = attemptOf(await runExisting(project, options), 'home');
        expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining(`${BUTTON.width * BUTTON.height} pixels`) });
        expect(attempt.artifacts.map((artifact) => path.posix.basename(artifact.path ?? ''))).toContain('home-diff.png');
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'passes no repeat against a screenshot another worker wrote in the same run, and names an unnamed one after a long title within a file name\'s bytes',
    async () => {
      const { fake } = screenEngine(() => screenPng(WHITE, BLUE));
      const title = 'スクリーンショット'.repeat(10);
      const test = `import { test, expect } from 'e2e';

test('${title}', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot({ timeout: 1000 });
});
`;
      const { outcome, project } = await runProject(
        { 'tests/repeat.e2e.ts': test },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake, { workers: 2 }), runOptions: { repeatEach: 2 } },
      );
      try {
        const results = outcome.report.run.results.filter((result) => result.titlePath.at(-1) === title);
        expect(results).toHaveLength(2);
        expect(results.map((result) => result.status)).toEqual(['failed', 'failed']);
        const [file] = readdirSync(path.join(project.dir, 'tests', 'repeat.e2e.ts-snapshots'));
        expect(file).toMatch(/^[スクリーンショット]+-[0-9a-f]{8}-1-fake-/u);
        expect(Buffer.byteLength(file!)).toBeLessThanOrEqual(150);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'refuses a screen scoped to a frame instead of comparing the whole viewport',
    async () => {
      const { fake, asked } = screenEngine(() => screenPng(WHITE, BLUE));
      const test = `import { test, expect } from 'e2e';

test('frame', async ({ app, gadget }) => {
  await app.open('/');
  await expect(gadget.frame()).toHaveScreenshot('pay.png');
});
`;
      const { outcome, project } = await runProject({ 'tests/frame.e2e.ts': test }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        expect(attemptOf(outcome, 'frame').error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('locator inside the frame') });
        expect(asked).toEqual([]);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it.each([
    ['a name with a path separator', `'../home'`, 'name must be a file name'],
    ['an unknown option', `'home', { fullPage: true }`, '"fullPage"'],
    ['a threshold above 1', `'home', { threshold: 2 }`, 'threshold must be a number from 0 to 1'],
    ['a mask that is not a locator', `'home', { mask: ['#clock'] }`, 'mask must be an array of locators'],
    ['a mask color that is not #rrggbb', `'home', { maskColor: 'red' }`, 'maskColor must be a color written #rrggbb'],
    ['a name too long for a file name', `'${'あ'.repeat(60)}'`, 'at most 150 bytes'],
  ])('refuses %s before it reads the screen', async (_label, args, message) => {
    const { fake, asked } = screenEngine(() => screenPng(WHITE, BLUE));
    const test = `import { test, expect } from 'e2e';

test('invalid', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).toHaveScreenshot(${args});
});
`;
    const { outcome, project } = await runProject({ 'tests/invalid.e2e.ts': test }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
    try {
      const error = attemptOf(outcome, 'invalid').error;
      expect(error?.code).toBe('INVALID_ARGUMENT');
      expect(error?.message).toContain(message);
      expect(asked).toEqual([]);
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it(
    'refuses a .not with nothing stored to differ from',
    async () => {
      const { fake } = screenEngine(() => screenPng(WHITE, BLUE));
      const test = `import { test, expect } from 'e2e';

test('negated', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen).not.toHaveScreenshot('home');
});
`;
      const { outcome, project } = await runProject({ 'tests/negated.e2e.ts': test }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        const error = attemptOf(outcome, 'negated').error;
        expect(error?.code).toBe('ASSERTION_FAILED');
        expect(error?.message).toContain('no stored screenshot');
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );
});
