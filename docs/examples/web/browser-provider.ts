import type { BrowserProvider } from '@e2edev/web';

/**
 * Leases browsers from a service that starts a Chromium per session and
 * exposes its DevTools endpoint. Replace the three requests with your
 * service's API.
 */
export function hostedBrowsers(options: { serviceUrl: string; scope?: 'worker' | 'attempt' }): BrowserProvider {
  return {
    name: 'hosted-browsers',
    scope: options.scope ?? 'worker',
    async acquire(request) {
      const token = request.env['BROWSER_SERVICE_TOKEN'];
      if (token === undefined || token === '') throw new Error('BROWSER_SERVICE_TOKEN is not set');
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      // 1. Ask for a browser; name the session after the run so it can be found later.
      const created = await fetch(`${options.serviceUrl}/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `e2e ${request.runId} ${request.targetName} ${request.attemptId ?? `slot ${request.slot + 1} of ${request.slots}`}`,
        }),
        signal: request.signal,
      });
      if (!created.ok) throw new Error(`browser service: HTTP ${created.status}`);
      const { id } = (await created.json()) as { id: string };
      // 2. Wait until the session exposes its DevTools endpoint.
      for (;;) {
        const response = await fetch(`${options.serviceUrl}/sessions/${id}`, { headers, signal: request.signal });
        const session = (await response.json()) as { status: string; cdpUrl?: string; viewerUrl?: string };
        if (session.status === 'ready' && session.cdpUrl !== undefined) {
          if (session.viewerUrl !== undefined) request.log(`watch at ${session.viewerUrl}`);
          return { id, cdpEndpoint: session.cdpUrl };
        }
        if (session.status !== 'starting') throw new Error(`browser service: session ${id} is ${session.status}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    },
    async release(lease, context) {
      // 3. Stop the session; the run waits for this within cleanupTimeout.
      const token = context.env['BROWSER_SERVICE_TOKEN'] ?? '';
      await fetch(`${options.serviceUrl}/sessions/${lease.id}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: context.signal,
      });
    },
  };
}
