/**
 * The CDP reorder in front of the chromium-bidi mapper: a redirect hop's
 * request-stage pause reaches the mapper after the hop's
 * `Network.requestWillBeSent`, whichever Chrome sent first.
 */

import { describe, expect, it } from 'vitest';
import { orderRedirectPauses } from '../../src/bidi/redirect-pause-order.ts';

const willBeSent = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.requestWillBeSent', sessionId, params: { requestId } });
const paused = (networkId: string, sessionId = 's', extra: Record<string, unknown> = {}): string => JSON.stringify({ method: 'Fetch.requestPaused', sessionId, params: { requestId: `fetch-${networkId}`, networkId, ...extra } });
const finished = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.loadingFinished', sessionId, params: { requestId } });

/** Runs `messages` through the reorder and returns what the mapper received, in order. */
function reorder(messages: string[]): string[] {
  const delivered: string[] = [];
  const handle = orderRedirectPauses((message) => delivered.push(message));
  for (const message of messages) handle(message);
  return delivered;
}

describe('orderRedirectPauses', () => {
  it('passes the usual order through', () => {
    const messages = [willBeSent('r'), paused('r'), willBeSent('r'), paused('r'), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('lets a first hop\'s early pause through, which the mapper handles', () => {
    const messages = [paused('r'), willBeSent('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('holds a redirect hop\'s early pause until the hop is sent', () => {
    const extra = JSON.stringify({ method: 'Network.requestWillBeSentExtraInfo', sessionId: 's', params: { requestId: 'r' } });
    expect(reorder([willBeSent('r'), paused('r'), paused('r'), extra, willBeSent('r')]))
      .toEqual([willBeSent('r'), paused('r'), extra, willBeSent('r'), paused('r')]);
  });

  it('never holds a response-stage pause', () => {
    const response = paused('r', 's', { responseStatusCode: 302 });
    expect(reorder([willBeSent('r'), paused('r'), response])).toEqual([willBeSent('r'), paused('r'), response]);
  });

  it('keeps each session\'s request ids apart', () => {
    expect(reorder([willBeSent('r', 'a'), paused('r', 'a'), paused('r', 'b')]))
      .toEqual([willBeSent('r', 'a'), paused('r', 'a'), paused('r', 'b')]);
  });

  it('hands a held pause on when its request ends without another hop', () => {
    expect(reorder([willBeSent('r'), paused('r'), paused('r'), finished('r')]))
      .toEqual([willBeSent('r'), paused('r'), finished('r'), paused('r')]);
  });
});
