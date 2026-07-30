/**
 * Driver resolution: well-known ids load their own package on demand, imported
 * handles pass through untouched, and anything else is a configuration error.
 */

import { describe, expect, it } from 'vitest';
import { defineDriver, type Driver } from '../../src/driver/index.ts';
import { DEFAULT_DRIVER_ID, WELL_KNOWN_DRIVERS } from '../../src/config/drivers.ts';
import type { ResolvedTarget } from '../../src/config/resolve.ts';
import { resolveDriver } from '../../src/run/resolve-driver.ts';
import { E2EError } from '../../src/internal/errors.ts';

function target(driver: ResolvedTarget['driver']): ResolvedTarget {
  return {
    name: 'web',
    index: 0,
    platform: 'web',
    browser: 'chromium',
    viewport: undefined,
    driver,
    driverTarget: { name: 'web', platform: 'web', browser: 'chromium' },
  };
}

const handle: Driver = defineDriver({
  id: 'stub',
  version: '1.0.0',
  platforms: ['web'],
  spiVersion: 1,
  capabilities: { fixtures: ['web'], artifacts: [], state: false },
  launch: () => Promise.reject(new Error('not launched in this test')),
});

describe('resolveDriver', () => {
  it('loads a well-known id from its own package', async () => {
    const driver = await resolveDriver(target(DEFAULT_DRIVER_ID));
    expect(driver.id).toBe(DEFAULT_DRIVER_ID);
    expect(driver.spiVersion).toBe(1);
    expect(driver.capabilities.fixtures).toEqual(WELL_KNOWN_DRIVERS[DEFAULT_DRIVER_ID]?.capabilities);
  });

  it('creates an independent instance per call, so workers never share one', async () => {
    const first = await resolveDriver(target(DEFAULT_DRIVER_ID));
    const second = await resolveDriver(target(DEFAULT_DRIVER_ID));
    expect(first).not.toBe(second);
  });

  it('returns an imported handle without touching it', async () => {
    expect(await resolveDriver(target(handle))).toBe(handle);
  });

  it('rejects an unknown driver id as a configuration error', async () => {
    const error = await resolveDriver(
      target('nope' as ResolvedTarget['driver']),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(E2EError);
    expect((error as E2EError).category).toBe('configuration');
    expect((error as E2EError).code).toBe('INVALID_CONFIG');
  });
});

describe('well-known driver registry', () => {
  it('declares a capability hint for every id, since selection runs before launch', () => {
    for (const [id, entry] of Object.entries(WELL_KNOWN_DRIVERS)) {
      expect(entry.specifier, id).not.toBe('');
      expect(entry.capabilities.length, id).toBeGreaterThan(0);
    }
  });

  it('has a default id that is itself well known', () => {
    expect(WELL_KNOWN_DRIVERS[DEFAULT_DRIVER_ID]).toBeDefined();
  });
});
