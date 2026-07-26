import { describe, expect, it } from 'vitest';
import { defineDriver, DriverError, isDriverHandle, verifyDriver } from '../../src/driver/index.ts';

const manifest = {
  id: 'test-driver',
  version: '1.0.0',
  platforms: ['web'] as const,
  spiVersion: 1 as const,
  capabilities: { fixtures: ['web'] as const, artifacts: ['screenshot'] as const, state: false },
  launch: () => Promise.reject(new Error('unused')),
};

describe('defineDriver', () => {
  it('brands and freezes a valid definition', () => {
    const driver = defineDriver(manifest);
    expect(isDriverHandle(driver)).toBe(true);
    expect(Object.isFrozen(driver)).toBe(true);
    expect(isDriverHandle({ ...manifest })).toBe(false);
  });

  it('rejects invalid IDs, versions, platforms, and SPI versions', () => {
    expect(() => defineDriver({ ...manifest, id: 'Bad_ID' })).toThrow(/lowercase/);
    expect(() => defineDriver({ ...manifest, version: '' })).toThrow(/version/);
    expect(() => defineDriver({ ...manifest, platforms: [] })).toThrow(/platforms/);
    expect(() => defineDriver({ ...manifest, spiVersion: 2 as never })).toThrow(/SPI/);
  });

  it('passes an optional dispose through and rejects non-function dispose', async () => {
    let disposed = 0;
    const driver = defineDriver({
      ...manifest,
      dispose: async () => {
        disposed += 1;
      },
    });
    await driver.dispose?.();
    expect(disposed).toBe(1);
    expect(defineDriver(manifest).dispose).toBeUndefined();
    expect(() => defineDriver({ ...manifest, dispose: 'nope' as never })).toThrow(/dispose/);
  });
});

describe('isDriverHandle', () => {
  it('rejects primitives, null, and unbranded objects', () => {
    expect(isDriverHandle(undefined)).toBe(false);
    expect(isDriverHandle(null)).toBe(false);
    expect(isDriverHandle('playwright')).toBe(false);
    expect(isDriverHandle(42)).toBe(false);
    expect(isDriverHandle({})).toBe(false);
  });
});

describe('verifyDriver', () => {
  it('rejects with a clear not-implemented error until the harness lands', async () => {
    await expect(
      verifyDriver({
        driver: defineDriver(manifest),
        profiles: ['driver-1'],
        artifactSha256: '0'.repeat(64),
        createTarget: () => ({ name: 'web', platform: 'web', browser: 'chromium' }),
      }),
    ).rejects.toThrow(/not implemented yet/);
  });
});

describe('DriverError', () => {
  it('allows retryable only for NODE_STALE and FRAME_NOT_FOUND', () => {
    expect(new DriverError('NODE_STALE', 'x', { retryable: true }).retryable).toBe(true);
    expect(new DriverError('FRAME_NOT_FOUND', 'x', { retryable: true }).retryable).toBe(true);
    expect(new DriverError('NOT_ACTIONABLE', 'x', { retryable: false }).retryable).toBe(false);
  });

  it('coerces illegal retryable combinations to DRIVER_FAILURE', () => {
    const error = new DriverError('ACTION_MAY_HAVE_COMMITTED', 'x', { retryable: true });
    expect(error.code).toBe('DRIVER_FAILURE');
    expect(error.retryable).toBe(false);
  });
});
