/**
 * `context` and `launch` reach the real browser: what a page reads back
 * (language, time zone, color scheme, touch, user agent, viewport) is what
 * the config said, on the first context and on the one a state reset
 * replaces it with. Driven through the engine hooks, as the attempt executor
 * drives them.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { devices } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-context', attemptId, origin: 'test' };
}

async function boot(engine: EngineHandle, app: FixtureApp, artifactsDir: string, attemptId: string): Promise<void> {
  await engine.init!({
    runId: 'run-context',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: { site: new URL(app.url).hostname },
    env: {},
    headed: false,
    workerSlot: 0,
    signal: new AbortController().signal,
  });
  await engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal });
}

async function shutdown(engine: EngineHandle): Promise<void> {
  await engine.endAttempt!(cleanup());
  await engine.dispose!(cleanup());
}

interface Environment {
  readonly language: string;
  readonly timeZone: string;
  readonly dark: boolean;
  readonly touchPoints: number;
  readonly userAgent: string;
}

/** What the page believes about its environment. */
function readEnvironment(): Environment {
  return {
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    touchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
  };
}

describe('web({ context, launch })', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-context-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('applies locale, time zone, and color scheme to every context of the attempt', async () => {
    const engine = web({
      url: app.url,
      context: { locale: 'de-DE', timezoneId: 'Europe/Warsaw', colorScheme: 'dark' },
    });
    try {
      await boot(engine, app, artifactsDir, 'c1');
      await engine.session!.open!(`${app.url}/`, operation('c1'));
      const first = await surfaceOf(engine)!.page().evaluate(readEnvironment);
      expect(first).toMatchObject({ language: 'de-DE', timeZone: 'Europe/Warsaw', dark: true });
      await engine.session!.reset!(operation('c1'));
      await engine.session!.open!(`${app.url}/`, operation('c1'));
      const second = await surfaceOf(engine)!.page().evaluate(readEnvironment);
      expect(second).toMatchObject({ language: 'de-DE', timeZone: 'Europe/Warsaw', dark: true });
    } finally {
      await shutdown(engine);
    }
  });

  it('emulates a device spread into the context, its viewport becoming the attempt viewport', async () => {
    const phone = devices['iPhone 13']!;
    const engine = web({ url: app.url, context: { ...phone } });
    try {
      await boot(engine, app, artifactsDir, 'c2');
      await engine.session!.open!(`${app.url}/`, operation('c2'));
      const page = surfaceOf(engine)!.page();
      expect(page.viewportSize()).toEqual(phone.viewport);
      const environment = await page.evaluate(readEnvironment);
      expect(environment.touchPoints).toBeGreaterThan(0);
      expect(environment.userAgent).toContain('iPhone');
      // The engine's own screenshot covers the same viewport, at the device's scale factor.
      const screenshot = await engine.artifacts!.screenshot!('phone', operation('c2'));
      const png = decodePng(readFileSync(path.join(artifactsDir, screenshot)));
      expect(png.width).toBe(phone.viewport.width * phone.deviceScaleFactor);
      // Chromium rounds the scaled height by a pixel.
      expect(Math.abs(png.height - phone.viewport.height * phone.deviceScaleFactor)).toBeLessThanOrEqual(1);
    } finally {
      await shutdown(engine);
    }
  });

  it('passes launch options to the browser process', async () => {
    const engine = web({ url: app.url, launch: { args: ['--user-agent=e2e-launch-args'] } });
    try {
      await boot(engine, app, artifactsDir, 'l1');
      await engine.session!.open!(`${app.url}/`, operation('l1'));
      const environment = await surfaceOf(engine)!.page().evaluate(readEnvironment);
      expect(environment.userAgent).toBe('e2e-launch-args');
    } finally {
      await shutdown(engine);
    }
  });
});
