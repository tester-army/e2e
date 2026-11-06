/**
 * Fixes for two faults of the chromium-bidi mapper (still present in 159.0.8147), applied to
 * the CDP stream it reads.
 *
 * Redirect pauses: Chrome sends a redirect hop's `Fetch.requestPaused` and
 * its `Network.requestWillBeSent` in either order, and the mapper handles a
 * pause that comes first only for a request's first hop: a later hop's early
 * pause lands on the previous hop, which already reported
 * `network.beforeRequestSent`, so the mapper continues the hop untouched and
 * never reports it, and a route's header overrides never reach the redirect.
 * Each such pause is held until its hop is sent. A request that never sends
 * `Network.requestWillBeSent` is never held.
 *
 * Site icons: the mapper drops every event of a request whose URL ends in
 * `/favicon.ico` (`NetworkRequest#isIgnoredEvent`), yet still blocks it when
 * an intercept covers it, so the request would stay paused with no driver
 * ever told. Its pauses are answered here, as the mapper answers a request no
 * intercept blocks, and never reach the mapper.
 */

/** Counts, per request id of a CDP session, the hops sent and paused, and the pauses waiting for their hop. */
interface RequestHops {
  sent: number;
  paused: number;
  held: string[];
}

/** What the fixups read of a CDP message. */
interface CdpMessage {
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: {
    readonly requestId?: string;
    readonly networkId?: string;
    readonly sessionId?: string;
    readonly responseStatusCode?: number;
    readonly responseErrorReason?: string;
    readonly request?: { readonly url?: string };
  };
}

const WATCHED = ['"Network.requestWillBeSent"', '"Fetch.requestPaused"', '"Fetch.authRequired"', '"Network.loadingFinished"', '"Network.loadingFailed"', '"Target.detachedFromTarget"'];

/** The ids of the fixups' own CDP commands, far above any the mapper numbers up from 0, so no answer reaches a command of its. */
const FIRST_COMMAND_ID = 2_000_000_000;

/** A CDP message from the browser; only optional fields are read. */
function parse(message: string): CdpMessage {
  // oxlint-disable-next-line e2e/no-unchecked-json -- a CDP message from the browser; only optional fields are read
  return JSON.parse(message) as CdpMessage;
}

/** Whether the mapper ignores every event of the request `message` pauses, its own rule. */
function isSiteIcon(message: CdpMessage): boolean {
  return message.params?.request?.url?.endsWith('/favicon.ico') === true;
}

/**
 * Wraps the mapper's CDP message handler (`deliver`): each redirect hop's
 * request-stage `Fetch.requestPaused` reaches it after the hop's
 * `Network.requestWillBeSent`, and a site icon's pauses are answered on
 * `send`, the mapper's CDP socket, instead of reaching it. Every other
 * message passes through in order, unparsed unless it names one of the
 * events the fixups depend on.
 */
export function cdpFixups(deliver: (message: string) => void, send: (message: string) => void): (message: string) => void {
  const sessions = new Map<string, Map<string, RequestHops>>();
  let nextId = FIRST_COMMAND_ID;
  const command = (sessionId: string, method: string, params: Record<string, unknown>): void => {
    send(JSON.stringify({ id: nextId++, method, params, ...(sessionId === '' ? {} : { sessionId }) }));
  };
  const hopsOf = (session: string, request: string): RequestHops => {
    let requests = sessions.get(session);
    if (requests === undefined) sessions.set(session, (requests = new Map()));
    let hops = requests.get(request);
    if (hops === undefined) requests.set(request, (hops = { sent: 0, paused: 0, held: [] }));
    return hops;
  };
  /** Hands a request-stage pause on: to the mapper, or for a site icon, straight back to the browser. */
  const pause = (message: string, parsed: CdpMessage = parse(message)): void => {
    if (isSiteIcon(parsed) && parsed.params?.requestId !== undefined) command(parsed.sessionId ?? '', 'Fetch.continueRequest', { requestId: parsed.params.requestId });
    else deliver(message);
  };
  return (message) => {
    if (!WATCHED.some((method) => message.includes(method))) {
      deliver(message);
      return;
    }
    const parsed = parse(message);
    const { method, sessionId = '', params } = parsed;
    if (method === 'Fetch.authRequired' && isSiteIcon(parsed) && params?.requestId !== undefined) {
      command(sessionId, 'Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: { response: 'Default' } });
      return;
    }
    if (method === 'Fetch.requestPaused' && params?.responseStatusCode === undefined && params?.responseErrorReason === undefined) {
      const hops = params?.networkId === undefined ? undefined : hopsOf(sessionId, params.networkId);
      if (hops !== undefined && hops.sent > 0 && hops.paused >= hops.sent) {
        hops.held.push(message);
        return;
      }
      if (hops !== undefined) hops.paused++;
      pause(message, parsed);
      return;
    }
    deliver(message);
    if (method === 'Network.requestWillBeSent' && params?.requestId !== undefined) {
      const hops = hopsOf(sessionId, params.requestId);
      hops.sent++;
      const held = hops.held.shift();
      if (held !== undefined) {
        hops.paused++;
        pause(held);
      }
    } else if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && params?.requestId !== undefined) {
      const requests = sessions.get(sessionId);
      for (const held of requests?.get(params.requestId)?.held ?? []) pause(held);
      requests?.delete(params.requestId);
    } else if (method === 'Target.detachedFromTarget' && params?.sessionId !== undefined) {
      sessions.delete(params.sessionId);
    }
  };
}
