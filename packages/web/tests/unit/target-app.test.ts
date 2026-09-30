/**
 * The app under test is the target's: `web()` refuses the options that used
 * to describe it, and checks the target's `app` for what a browser needs.
 */

import { describe, expect, it } from 'vitest';
import { web } from '../../src/index.ts';

describe('web() and the target app', () => {
  it('refuses every option that moved to the target at once, with the target block they make', () => {
    expect(() => web({ url: 'http://localhost:3000', command: { executable: 'pnpm' }, viewport: { width: 1, height: 1 } } as never)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message:
          'web({ url, command }) moved to the target: the app under test is declared there, as targets: [{ engine: web(), app: { url, command } }]; web() only drives it',
      }),
    );
  });

  it('refuses services, which this version does not start', () => {
    expect(() => web({ services: [] } as never)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: "web({ services }) is gone: the runner starts only the target's app.command, so start dependency processes before the run; a services API returns in a later release",
      }),
    );
  });

  it('needs app.url on the target, and refuses the fields of an installed device app', () => {
    const { validateApp } = web();
    const info = { targetName: 'chromium' };
    expect(() => validateApp!({ url: 'http://localhost:3000' }, info)).not.toThrow();
    expect(() => validateApp!({}, info)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('target "chromium" needs app.url') }),
    );
    for (const key of ['bundleId', 'appPath', 'launchArguments', 'permissions'] as const) {
      expect(() => validateApp!({ url: 'http://localhost:3000', [key]: key === 'launchArguments' ? ['-x'] : key === 'permissions' ? {} : 'x' }, info)).toThrowError(
        expect.objectContaining({ message: `target "chromium" declares app.${key}, which describes an installed device app; a web() target opens app.url` }),
      );
    }
  });
});
