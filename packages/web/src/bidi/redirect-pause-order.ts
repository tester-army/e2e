/**
 * Puts a redirect hop's `Fetch.requestPaused` after its
 * `Network.requestWillBeSent` on the CDP stream the chromium-bidi mapper
 * reads. Chrome sends the two in either order, and the mapper (159.0.8146)
 * handles a pause that comes first only for a request's first hop: a later
 * hop's early pause lands on the previous hop, which already reported
 * `network.beforeRequestSent`, so the mapper continues the hop untouched and
 * never reports it, and a route's header overrides never reach the redirect.
 * A request that never sends `Network.requestWillBeSent` is never held.
 */

/** Counts, per request id of a CDP session, the hops sent and paused, and the pauses waiting for their hop. */
interface RequestHops {
  sent: number;
  paused: number;
  held: string[];
}

/** What the reorder reads of a CDP message. */
interface CdpMessage {
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: {
    readonly requestId?: string;
    readonly networkId?: string;
    readonly sessionId?: string;
    readonly responseStatusCode?: number;
    readonly responseErrorReason?: string;
  };
}

const WATCHED = ['"Network.requestWillBeSent"', '"Fetch.requestPaused"', '"Network.loadingFinished"', '"Network.loadingFailed"', '"Target.detachedFromTarget"'];

/**
 * Wraps the mapper's CDP message handler so each redirect hop's request-stage
 * `Fetch.requestPaused` reaches it after the hop's `Network.requestWillBeSent`;
 * every other message passes through in order, unparsed unless it names one
 * of the events the order depends on.
 */
export function orderRedirectPauses(deliver: (message: string) => void): (message: string) => void {
  const sessions = new Map<string, Map<string, RequestHops>>();
  const hopsOf = (session: string, request: string): RequestHops => {
    let requests = sessions.get(session);
    if (requests === undefined) sessions.set(session, (requests = new Map()));
    let hops = requests.get(request);
    if (hops === undefined) requests.set(request, (hops = { sent: 0, paused: 0, held: [] }));
    return hops;
  };
  return (message) => {
    if (!WATCHED.some((method) => message.includes(method))) {
      deliver(message);
      return;
    }
    // oxlint-disable-next-line e2e/no-unchecked-json -- a CDP message from the browser; only optional fields are read
    const { method, sessionId = '', params } = JSON.parse(message) as CdpMessage;
    if (method === 'Fetch.requestPaused' && params?.networkId !== undefined && params.responseStatusCode === undefined && params.responseErrorReason === undefined) {
      const hops = hopsOf(sessionId, params.networkId);
      if (hops.sent > 0 && hops.paused >= hops.sent) {
        hops.held.push(message);
        return;
      }
      hops.paused++;
      deliver(message);
      return;
    }
    deliver(message);
    if (method === 'Network.requestWillBeSent' && params?.requestId !== undefined) {
      const hops = hopsOf(sessionId, params.requestId);
      hops.sent++;
      const pause = hops.held.shift();
      if (pause !== undefined) {
        hops.paused++;
        deliver(pause);
      }
    } else if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && params?.requestId !== undefined) {
      const requests = sessions.get(sessionId);
      for (const pause of requests?.get(params.requestId)?.held ?? []) deliver(pause);
      requests?.delete(params.requestId);
    } else if (method === 'Target.detachedFromTarget' && params?.sessionId !== undefined) {
      sessions.delete(params.sessionId);
    }
  };
}
