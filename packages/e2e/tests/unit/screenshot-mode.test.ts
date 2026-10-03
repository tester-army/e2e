/** Which steps the runner screenshots: the mode's resolution over the config, a target, and `--screenshot`. */

import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliOverrides } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { isScreenshotMode } from '../../src/internal/screenshot-mode.ts';
import type { E2EConfig, Target } from '../../src/types.ts';
import { snapshot } from '../helpers/snapshot.ts';

const ROOT = '/tmp/e2e-screenshot-project';

function target(extra: Partial<Target> = {}): Target {
  const engine = defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) });
  return { name: 'web', platform: 'web', engine, ...extra };
}

function resolve(raw: Partial<E2EConfig>, cli: CliOverrides = {}) {
  return resolveConfig({ targets: [target()], ...raw }, { projectRoot: ROOT, env: {}, cli });
}

function failure(raw: Partial<E2EConfig>, cli: CliOverrides = {}): { code: string; message: string } {
  try {
    resolve(raw, cli);
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected the config to be refused');
}

describe('screenshot mode', () => {
  it('defaults to on-failure, what the runner did before the option existed', () => {
    expect(resolve({}).targets[0]!.screenshot).toBe('on-failure');
  });

  it('takes the config root, then the target, then --screenshot', () => {
    expect(resolve({ screenshot: 'off' }).targets[0]!.screenshot).toBe('off');
    expect(resolve({ screenshot: 'off', targets: [target({ screenshot: 'every-step' })] }).targets[0]!.screenshot).toBe('every-step');
    expect(resolve({ targets: [target({ screenshot: 'every-step' })] }, { screenshot: 'off' }).targets[0]!.screenshot).toBe('off');
  });

  it('refuses an unknown mode, naming the modes', () => {
    expect(failure({ screenshot: 'always' as never })).toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'screenshot must be one of on-failure, every-step, off, got "always"',
    });
    expect(failure({ targets: [target({ screenshot: true as never })] }).message).toMatch(/^target "web" screenshot must be one of on-failure, every-step, off/);
    expect(failure({}, { screenshot: 'all' as never }).message).toMatch(/^--screenshot must be one of/);
  });

  it('knows the three modes and nothing else', () => {
    for (const mode of ['on-failure', 'every-step', 'off']) expect(isScreenshotMode(mode)).toBe(true);
    for (const value of ['on', 'always', true, undefined]) expect(isScreenshotMode(value)).toBe(false);
  });
});

describe('screenshot mode and the config digest', () => {
  it('never enters the digest, so turning screenshots on keeps every replay valid', () => {
    const plain = resolve({}).configDigest;
    expect(resolve({ screenshot: 'every-step' }).configDigest).toBe(plain);
    expect(resolve({ targets: [target({ screenshot: 'off' })] }).configDigest).toBe(plain);
  });
});
