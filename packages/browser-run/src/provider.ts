/** Leases Cloudflare Browser Run sessions over the public CDP HTTP API. */
import type { BrowserLease, BrowserProvider, BrowserProviderScope, BrowserRequest, BrowserReleaseContext } from '@e2e-dev/web';
import { request, resultOf } from './http.ts';
import { LeaseJournal, SESSION_ID } from './journal.ts';

const API = 'https://api.cloudflare.com/client/v4';

/** Browser lifetime and Cloudflare's session launch options. Credentials come from the run's environment. */
export interface BrowserRunOptions {
  /** One browser per worker slot by default; `attempt` acquires a fresh browser for every attempt. */
  readonly scope?: BrowserProviderScope | undefined;
  /** Inactivity timeout in milliseconds, from 10,000 to 1,200,000. Default: 60,000. */
  readonly keepAlive?: number | undefined;
}

/** Required credentials are read on use, so importing a config needs no login. */
function credentials(env: BrowserRequest['env']) {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();

  if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');

  if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID');

  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');

  if (/[\r\n]/.test(token)) throw new Error('CLOUDFLARE_API_TOKEN must not contain line breaks');

  return { base: `${API}/accounts/${account}/browser-rendering/devtools/browser`, headers: { Authorization: `Bearer ${token}` } };
}

interface SessionResult {
  readonly sessionId: string;
}

/** Accepts only session IDs that can safely name a journal receipt and CDP endpoint. */
function isSessionResult(value: unknown): value is SessionResult {
  return value !== null && typeof value === 'object' && 'sessionId' in value &&
    typeof value.sessionId === 'string' && SESSION_ID.test(value.sessionId);
}

/** Resolves the same private journal independently in the parent and every worker. */
function journal(context: BrowserReleaseContext): LeaseJournal {
  return new LeaseJournal(context.env.CLOUDFLARE_ACCOUNT_ID!.trim(), context.runId, context.targetName);
}

/** Closes only the requested session; an expired or already deleted session is already released. */
async function release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void> {
  const { base, headers } = credentials(context.env);
  const response = await request(`${base}/${encodeURIComponent(lease.id)}`, 'DELETE', headers, context.signal);
  await response.body?.cancel();
  await journal(context).forget(lease.id);
}

/**
 * Cloudflare browsers for `web({ browser: browserRun() })`. Uses the run's
 * `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, never ambient credentials.
 * The engine owns isolation, screenshots, and per-attempt screencast video.
 */
export function browserRun(options: BrowserRunOptions = {}): BrowserProvider {
  const { scope, keepAlive = 60_000 } = options;

  if (!Number.isInteger(keepAlive) || keepAlive < 10_000 || keepAlive > 1_200_000) {
    throw new Error('browserRun keepAlive must be an integer from 10000 to 1200000 milliseconds');
  }

  if (scope !== undefined && scope !== 'worker' && scope !== 'attempt') throw new Error('browserRun scope must be worker or attempt');

  const provider: BrowserProvider = {
    name: 'browser-run',
    ...(scope === undefined ? {} : { scope }),
    async acquire(context): Promise<BrowserLease> {
      const { base, headers } = credentials(context.env);
      const url = new URL(base);
      url.searchParams.set('keep_alive', String(keepAlive));

      const response = await request(url.href, 'POST', headers, context.signal);
      const result = await resultOf(response, isSessionResult, 'Cloudflare Browser Run returned no valid sessionId');
      // Construct the endpoint ourselves so a response cannot send the token to another origin.
      const lease = { id: result.sessionId, cdpEndpoint: `${base.replace('https:', 'wss:')}/${result.sessionId}` };

      try {
        await journal(context).remember(lease.id);
      } catch (cause) {
        await release(lease, { ...context, signal: AbortSignal.timeout(10_000) });
        throw new Error('Cloudflare Browser Run could not journal the session; session released', { cause });
      }

      if (context.signal.aborted) {
        await release(lease, { ...context, signal: AbortSignal.timeout(10_000) });
        throw new Error('Cloudflare Browser Run acquisition cancelled; session released');
      }

      context.log(`browser ${lease.id}`);

      return lease;
    },
    release,
    cdpHeaders(_lease, context) {
      return credentials(context.env).headers;
    },
    async sweep(context) {
      credentials(context.env);
      const receipts = journal(context);
      const ids = await receipts.outstanding();
      const deleted: string[] = [];
      const failed: string[] = [];

      for (const id of ids) {
        try {
          await release({ id, cdpEndpoint: '' }, context);
          deleted.push(id);
        } catch {
          failed.push(id);
        }
      }

      await receipts.prune();

      if (failed.length > 0) throw new Error(`Cloudflare Browser Run could not release ${failed.length} journaled session(s); receipts kept for retry`);

      return deleted;
    },
  };

  return provider;
}
