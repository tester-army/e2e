import type { TraceKeyContext } from '../../src/cache/trace.ts';
import { canonicalDigest, sha256Hex } from '../../src/internal/ids.ts';
import { REPLAY_POLICY_VERSION } from '../../src/cache/relocate.ts';

/** Complete validity metadata for recordings that tests construct without running an agent. */
export function cacheContext(platform = 'web'): TraceKeyContext {
  return {
    cacheSchema: 'trace-1', policyVersion: REPLAY_POLICY_VERSION, project: sha256Hex('fixture'),
    platform, engineName: platform === 'web' ? 'web' : 'mobile', engineSpiVersion: 1,
    appIdentity: canonicalDigest({ identity: platform === 'web' ? 'http://localhost/' : 'com.e2e.fixture', environment: 'test' }),
    agentContextDigest: sha256Hex(''),
  };
}
