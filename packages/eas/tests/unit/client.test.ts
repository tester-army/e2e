/**
 * `easSessions()` against Expo answers that are JSON but not the shape the
 * sessions API documents: each fails with an `EAS:` error naming the
 * operation, never a `TypeError` or a session state built from wrong types.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { easSessions } from '../../src/client.ts';

const signal = new AbortController().signal;
const client = easSessions({ accessToken: 'expo-test' });

const params = { appId: 'p1', platform: 'ios', name: 'e2e ios 1 of 1', tags: [] } as const;

/** Answers every request with `body` as JSON. */
function answer(body: unknown): void {
  vi.stubGlobal('fetch', async () => Response.json(body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('easSessions()', () => {
  it('names an answer that is not a GraphQL object as one without data', async () => {
    answer(null);
    await expect(client.state('s1', signal)).rejects.toThrow(new Error('EAS: HTTP 200, no data'));
  });

  it('falls back to the status for a GraphQL error that is not an object', async () => {
    answer({ errors: [null], data: null });
    await expect(client.state('s1', signal)).rejects.toThrow(new Error('EAS: HTTP 200'));
  });

  it('rejects a created session without its app', async () => {
    answer({ data: { deviceRunSession: { createDeviceRunSession: { id: 's1' } } } });
    await expect(client.create(params, signal)).rejects.toThrow(new Error('EAS: unexpected response to createDeviceRunSession'));
  });

  it('rejects a session state with no session, or a daemon address that is not a string', async () => {
    answer({ data: { deviceRunSessions: { byId: null } } });
    await expect(client.state('s1', signal)).rejects.toThrow(new Error('EAS: unexpected response to deviceRunSessions.byId'));
    answer({
      data: {
        deviceRunSessions: {
          byId: { status: 'IN_PROGRESS', turtleJobRun: { status: 'IN_PROGRESS' }, remoteConfig: { agentDeviceRemoteSessionUrl: 42, agentDeviceRemoteSessionToken: 'daemon-token' } },
        },
      },
    });
    await expect(client.state('s1', signal)).rejects.toThrow(new Error('EAS: unexpected response to deviceRunSessions.byId'));
  });

  it('reads a daemon address GraphQL answers as null as not ready yet', async () => {
    answer({
      data: {
        deviceRunSessions: {
          byId: { status: 'IN_PROGRESS', turtleJobRun: { status: 'IN_PROGRESS' }, remoteConfig: { agentDeviceRemoteSessionUrl: null, agentDeviceRemoteSessionToken: null } },
        },
      },
    });
    await expect(client.state('s1', signal)).resolves.toEqual({ phase: 'starting' });
  });

  it('rejects a stop answer without the stopped session', async () => {
    answer({ data: { deviceRunSession: {} } });
    await expect(client.stop('s1', signal)).rejects.toThrow(new Error('EAS: unexpected response to ensureDeviceRunSessionStopped'));
  });

  it('rejects a stop answer that leaves out the job, rather than skip cancelling it', async () => {
    answer({ data: { deviceRunSession: { ensureDeviceRunSessionStopped: {} } } });
    await expect(client.stop('s1', signal)).rejects.toThrow(new Error('EAS: unexpected response to ensureDeviceRunSessionStopped'));
  });
});
