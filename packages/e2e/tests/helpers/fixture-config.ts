/** Fixture configs over one in-memory engine, in the shape `runProject` merges over its defaults. */

import type { EngineHandle } from '../../src/engine/index.ts';
import type { E2EConfig } from '../../src/index.ts';
import { FAKE_APP } from './fake-engine.ts';

/** A config whose one target is `engine` on the fake app; `extra` overrides the rest. */
export function engineConfig(engine: EngineHandle, extra: Partial<E2EConfig> = {}): Partial<E2EConfig> {
  return { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }], ...extra };
}
