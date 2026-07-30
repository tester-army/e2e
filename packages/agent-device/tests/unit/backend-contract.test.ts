/**
 * Pins the agent-device behaviours this driver compensates for.
 *
 * Each case below is a workaround for an upstream bug. A workaround that
 * outlives its bug is silently wrong, so these assert the bug still exists
 * against the pinned version. When one fails, upstream fixed it: delete the
 * workaround it names rather than the test.
 *
 * Only client-side behaviour is observable here, because a fake transport never
 * reaches the daemon's own validation. Two further workarounds are daemon-side
 * and are pinned by the device suite instead: empty fill text is rejected (so
 * `clear` types delete keys) and a bare ref is parsed as a selector (so the
 * sigil is added on dispatch). Neither becomes *wrong* if upstream fixes it,
 * only unnecessary; the scroll-duration one below would become wrong, since
 * dropping the duration would stop honouring momentum timing.
 */

import { describe, expect, it } from 'vitest';
import { createAgentDeviceClient } from 'agent-device';

interface Sent {
  command: string;
  positionals: readonly string[];
  flags: Record<string, unknown>;
}

/** Records what the client puts on the wire for one call. */
function recorder(): { sent: Sent[]; client: ReturnType<typeof createAgentDeviceClient> } {
  const sent: Sent[] = [];
  const client = createAgentDeviceClient(
    { session: 'contract' },
    {
      transport: (request) => {
        sent.push({
          command: request.command,
          positionals: request.positionals ?? [],
          flags: (request.flags ?? {}) as Record<string, unknown>,
        });
        return Promise.resolve({ ok: true as const, data: { message: 'ok' } });
      },
    },
  );
  return { sent, client };
}

describe('agent-device backend contract', () => {
  it('still drops a URL passed to open without an app', async () => {
    // Worked around in session.ts `openUrl`, which always sends the app too.
    const { sent, client } = recorder();
    await client.apps.open({ platform: 'ios', url: 'myapp://deep' }).catch(() => undefined);
    expect(sent[0]?.positionals).toEqual([]);
  });

  it('still carries the URL when the app accompanies it', async () => {
    const { sent, client } = recorder();
    await client.apps
      .open({ platform: 'ios', app: 'com.example.app', url: 'myapp://deep' })
      .catch(() => undefined);
    expect(sent[0]?.positionals).toEqual(['com.example.app', 'myapp://deep']);
  });

  it('still accepts a scroll duration that makes an iOS scroll a no-op', async () => {
    // Worked around in actions.ts `performScroll`, which sends distance only.
    // Measured on a device: with durationMs the list does not move at all.
    const { sent, client } = recorder();
    await client.interactions
      .scroll({ platform: 'ios', direction: 'down', amount: 0.75, durationMs: 500 })
      .catch(() => undefined);
    expect(sent[0]?.flags['durationMs']).toBe(500);
  });

  it('still exposes no key-press command, so keys are typed as text', async () => {
    // Worked around in keys.ts, which encodes a key value as typed text.
    const { client } = recorder();
    const interactions = client.interactions as unknown as Record<string, unknown>;
    expect(interactions['key']).toBeUndefined();
    expect(interactions['keyPress']).toBeUndefined();
  });

});
