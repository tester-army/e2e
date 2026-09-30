/**
 * The identity replay cache and session entries key on, pinned byte for byte.
 * The digests below were computed before the app moved from the engine's
 * options to the target's `app` (web({ url }), mobile({ app, appPath })), so
 * the same app declared the new way must keep every recording it made.
 */

import { describe, expect, it } from 'vitest';
import { assignPorts, resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { targetIdentity } from '../../src/run/sessions.ts';
import type { Target } from '../../src/types.ts';

const ROOT = '/tmp/e2e-target-identity';

/** An engine standing in for web() or mobile(): only its name, version, and platform reach the identity. */
function engine(name: string, platform: string) {
  return defineEngine({ name, version: '1.2.3', spiVersion: 1, platform });
}

/** The identity of the one target, resolved and then given the port a run would assign. */
function identityOf(target: Target) {
  const config = resolveConfig({ projectId: 'p', targets: [target] }, { projectRoot: ROOT, env: {} });
  return targetIdentity(assignPorts(config, { [config.targets[0]!.name]: 45678 }).targets[0]!);
}

describe('target identity', () => {
  it.each([
    [
      'a web app on a free port, keeping the declared :0',
      { name: 'chromium', engine: engine('web', 'web'), app: { url: 'http://127.0.0.1:0/app/', command: { executable: 'node', args: ['server.js', '{port}'] } } },
      '523f3dfa502c50418a9443ae5ceb42dc8d1f671cd5108fd96d0d75270f8c534b',
    ],
    ['a staging web app', { name: 'staging', engine: engine('web', 'web'), app: { url: 'https://staging.shop.dev', environment: 'staging' as const } }, '899e517e7f0e747facda088c5a45964dc5548314f50680d4095e6f74eb299157'],
    ['a preview with an explicit identity', { name: 'preview', engine: engine('web', 'web'), app: { url: 'https://pr-1.preview.dev', identity: 'shop' } }, '564358d83d8dcd7955d6793d5872f8c2f0830ef5ca03ebf343970456e2d59e54'],
    ['a device app by bundle id, beside its build', { name: 'ios', engine: engine('mobile', 'ios'), app: { bundleId: 'dev.shop.app', appPath: './build/Shop.app' } }, 'b5bc6a10395c7172343172f0b5ed1fab7dcb73c839c7a7756d339d02f7dafcb0'],
    ['a device app by its build alone', { name: 'android', engine: engine('mobile', 'android'), app: { appPath: './build/shop.apk' } }, 'a7df5f55b4b581f3f8c97ff111f527376a6093f8e24f98badfa8f23faf5d03d8'],
    [
      'a device app with an explicit identity and environment',
      { name: 'ios2', engine: engine('mobile', 'ios'), app: { bundleId: 'dev.shop.app', identity: 'shop-ios', environment: 'staging' as const } },
      '3e1a4768138dcfb789a335b5cd12e679c7c0818d71dea9d2a85c996e63b95616',
    ],
  ])('keys %s as it did before the move', (_label, target, appIdentity) => {
    const identity = identityOf(target);
    expect(identity).toEqual({
      targetId: target.name,
      engineName: target.engine.name,
      engineVersion: '1.2.3',
      spiVersion: 1,
      platform: target.engine.platform,
      appIdentity,
    });
  });
});
