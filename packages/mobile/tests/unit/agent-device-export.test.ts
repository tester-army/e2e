/**
 * `@e2e-dev/mobile/agent-device` gives custom tools the agent-device copy
 * this engine resolved. Two versions do not share one daemon, so the subpath
 * must re-export the engine's own import, not a copy of it.
 */

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
});
