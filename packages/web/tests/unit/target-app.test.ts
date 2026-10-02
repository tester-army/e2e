/**
 * The app under test is the target's: `web()` refuses the options that used
 * to describe it, and checks the target's `app` for what a browser needs.
 */

import { describe, expect, it } from 'vitest';
import { web } from '../../src/index.ts';

describe('web() and the target app', () => {
  it('refuses the app options it used to take as unknown keys', () => {
    expect(() => web({ url: 'http://localhost:3000' } as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringMatching(/^web\(\) has unknown key "url"/) }),
    );
    expect(() => web({ services: [] } as never)).toThrowError(expect.objectContaining({ message: expect.stringMatching(/^web\(\) has unknown key "services"/) }));
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
