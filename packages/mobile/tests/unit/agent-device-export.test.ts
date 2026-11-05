/**
 * `@e2e-dev/mobile/agent-device` gives custom tools the agent-device copy
 * this engine resolved. Two versions do not share one daemon, so the subpath
 * must re-export the engine's own import, not a copy of it.
 */

import { readFileSync } from 'node:fs';
import * as agentDevice from 'agent-device';
import { describe, expect, it } from 'vitest';
import * as subpath from '../../src/agent-device.ts';

describe('@e2e-dev/mobile/agent-device', () => {
  it('re-exports the values the engine imports, not copies of them', () => {
    for (const [name, value] of Object.entries(subpath)) {
      expect(value, name).toBe(agentDevice[name as keyof typeof agentDevice]);
    }
  });

  it('exports the chosen values and leaves daemon lifecycle to the engine', () => {
    expect(Object.keys(subpath).toSorted()).toEqual([
      'AppError',
      'centerOfRect',
      'createAgentDeviceClient',
      'isAgentDeviceError',
      'normalizeAgentDeviceError',
    ]);
  });

  it('is in the export map, built from its source module', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.exports['./agent-device']).toEqual({
      types: './dist/agent-device.d.ts',
      default: './dist/agent-device.js',
    });
  });
});
