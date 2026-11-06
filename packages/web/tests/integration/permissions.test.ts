/**
 * A web target's `app.permissions` in a real browser: headless Chromium
 * refuses the clipboard to a page unless the target grants it, and a grant
 * holds on every context the attempt opens. Driven through the engine hooks,
 * as the attempt executor drives them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppPermissionState } from 'e2e/engine';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('app permissions', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Boots one engine into a running attempt for a target granting `permissions`. */
  function boot(permissions?: Readonly<Record<string, AppPermissionState>>): Promise<WebSession> {
    return startWebSession(permissions === undefined ? {} : { app: { permissions } });
  }

  async function shutdown(engine: WebSession): Promise<void> {
    await engine.close();
  }

  /** Opens the app and copies `text` through the async clipboard, reading it back: the text, or the error the page got. */
  async function copy(engine: WebSession, text: string): Promise<string> {
    await engine.open(app.url);
    return (await engine.browser.evaluate(async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        return await navigator.clipboard.readText();
      } catch (error) {
        return String(error);
      }
    }, text)) as string;
  }

  it('gives every page the clipboard the target grants, after a restart and a context reset too', async ({ skip }) => {
    skip(onFirefox, 'Firefox limit: Firefox has no clipboard-read or clipboard-write permission to grant');
    const engine = await boot({ 'clipboard-read': 'grant', 'clipboard-write': 'grant' });
    try {
      expect(await copy(engine, 'first')).toBe('first');
      await engine.engine.session!.restart!(engine.op());
      expect(await copy(engine, 'second')).toBe('second');
      await engine.engine.session!.reset!(engine.op());
      expect(await copy(engine, 'third')).toBe('third');
    } finally {
      await shutdown(engine);
    }
  });

  it('leaves the clipboard refused when the target grants nothing', async () => {
    const engine = await boot();
    try {
      expect(await copy(engine, 'denied')).toMatch(/NotAllowedError/);
    } finally {
      await shutdown(engine);
    }
  });
});
