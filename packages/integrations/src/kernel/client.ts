/** The slice of the Kernel SDK the provider uses, loaded on first use so a config load never pays for it. */

import type { Kernel } from '@onkernel/sdk';

/** Kernel's create-browser body, its tags read-only. */
export type KernelBrowserParams = Omit<Kernel.BrowserCreateParams, 'tags'> & {
  readonly tags?: Readonly<Record<string, string>> | undefined;
};

interface KernelBrowser {
  readonly sessionId: string;
  readonly cdpWsUrl: string;
  readonly liveViewUrl?: string | undefined;
}

export interface KernelBrowsers {
  create(params: KernelBrowserParams, signal: AbortSignal): Promise<KernelBrowser>;
  /** Deletes the browser; one Kernel no longer knows counts as deleted. */
  delete(sessionId: string, signal: AbortSignal): Promise<void>;
}

/** Kernel browsers for one API key, through the SDK. */
export function kernelBrowsers(apiKey: string): KernelBrowsers {
  const sdk = import('@onkernel/sdk').then((module) => ({ client: new module.Kernel({ apiKey }), NotFoundError: module.NotFoundError }));
  return {
    async create(params, signal) {
      const { client } = await sdk;
      const created = await client.browsers.create({ ...params, tags: { ...params.tags } }, { signal });
      return { sessionId: created.session_id, cdpWsUrl: created.cdp_ws_url, liveViewUrl: created.browser_live_view_url };
    },
    async delete(sessionId, signal) {
      const { client, NotFoundError } = await sdk;
      try {
        await client.browsers.deleteByID(sessionId, { signal });
      } catch (cause) {
        if (!(cause instanceof NotFoundError)) throw cause;
      }
    },
  };
}
