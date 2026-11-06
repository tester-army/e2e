/**
 * Real CDP transport drops preserve only the dedicated persistent context,
 * never a replacement: the `connect.reconnectEndpoint` recovery. The BiDi
 * engine refuses that option at config load, so recovery is listed here as
 * the behavior to cover once it returns; the Playwright-era bodies are in
 * git history (fe6f9ad3f:packages/web/tests/integration/cdp-recovery.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { web } from '../../src/index.ts';

describe('CDP session recovery', () => {
  it('is refused at config load, naming the attach that works', () => {
    const endpoint = () => 'ws://127.0.0.1:9222';
    expect(() => web({ connect: { cdpEndpoint: endpoint, reconnectEndpoint: endpoint } })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('connect.reconnectEndpoint') }),
    );
  });

  // Missing in BiDi: connect.reconnectEndpoint recovery is refused at config load.
  it.todo('keeps the exact page, document state, storage, viewport, routes, and dialog handlers');
  it.todo('emulates the configured and requested media on the persistent page, after reconnect too');
  it.todo('runs configured and test init scripts once per document, after reconnect too');
  it.todo('fails an uncertain click without reconnecting or dispatching it twice');
  it.todo('rejects a different browser and never falls back to the provisioning resolver');
  it.todo('rejects a missing active target even when another tab has the same URL');
  it.todo('bounds a hung reconnect resolver and propagates cancellation to it');
  it.todo('provisions a fresh browser for each attempt and refuses accidental reuse');
  it.todo('shares recovery between concurrent operations while a cancelled waiter dispatches nothing');
  it.todo('counts reconnect time against the operation budget');
  it.todo('resumes video recording on the recovered page');
  it.todo('recovers before arming a download waiter and runs its trigger once');
  it.todo('allows direct test-code mouse input using current geometry while observation-derived taps stay stale');
  it.todo('requires new evidence for focused engine keyboard input after recovery while direct test input remains available');
  it.todo('rejects an observation that finishes during recovery and still requires new evidence');
  it.todo('masks password fields in light and closed shadow DOM before and after reconnect');
  it.todo('refuses recovery when disconnected navigation lost the closed-root tracking hook');
});
