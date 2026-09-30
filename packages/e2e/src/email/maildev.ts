/**
 * MailDev as a `MailProvider`: the local SMTP catcher for `config.email`,
 * for an app that sends its mail through an SMTP server the run controls.
 * MailDev keeps every message sent to it, whatever the address, so an address
 * is a name made up here and nothing is created per address; each message
 * carries its SMTP envelope, so a listing keeps exactly the mail delivered to
 * one address, Bcc included. Talks to MailDev's REST API with `fetch`: no
 * dependency, and no SDK.
 */

import { randomBytes } from 'node:crypto';
import { withAbort } from '../internal/time.ts';
import type { MailLease, MailMessage, MailProvider, MailSummary } from './types.ts';

export interface MaildevOptions {
  /** Where MailDev's REST API listens (the HTTP port it was started with); default `http://127.0.0.1:1080`. */
  readonly url?: string;
  /** The domain of the addresses handed out; default `maildev.test`. MailDev catches every address, so any domain the app accepts works. */
  readonly domain?: string;
}

const DEFAULT_URL = 'http://127.0.0.1:1080';
const DEFAULT_DOMAIN = 'maildev.test';
const HEALTH_CHECK_MS = 10_000;

/** One party of a MailDev message. */
interface MaildevAddress {
  readonly address: string;
  readonly name?: string;
}

/** A message as MailDev's REST API returns it. */
interface MaildevEmail {
  readonly id: string;
  readonly time: string;
  readonly subject?: string;
  readonly from?: readonly MaildevAddress[];
  readonly to?: readonly MaildevAddress[];
  readonly cc?: readonly MaildevAddress[];
  readonly text?: string;
  readonly html?: string;
  readonly envelope?: { readonly to?: readonly MaildevAddress[] };
}

/** A failure MailDev will not recover from on a retry: a request it rejected. */
class MaildevRejected extends Error {
  readonly retryable = false;
}

/**
 * MailDev for `email: maildev()`. Start it before the run, as a service of the
 * target's engine, and point the app's SMTP at MailDev's `--smtp` port.
 */
export function maildev(options: MaildevOptions = {}): MailProvider<MailLease> {
  const url = (options.url ?? DEFAULT_URL).replace(/\/+$/u, '');
  const domain = options.domain ?? DEFAULT_DOMAIN;
  let reachable: Promise<void> | undefined;
  /** Addresses handed out and not yet given back: one SMTP delivery to several of them is one message, kept until the last goes. */
  const live = new Set<string>();

  /** One REST call, its failure worded for a test log. */
  const call = async <T>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${url}/api/${path}`, { ...init, signal });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new Error(`MailDev is not answering at ${url} (${cause instanceof Error ? cause.message : String(cause)}); start it before the run, e.g. npx maildev, or pass maildev({ url })`, { cause });
    }
    if (!response.ok) {
      const message = `MailDev answered ${response.status} to ${init.method ?? 'GET'} /api/${path}`;
      throw response.status >= 500 ? new Error(message) : new MaildevRejected(message);
    }
    return (await response.json()) as T;
  };
  /** Every message delivered to exactly `address`, as the SMTP envelope and the headers name it. */
  const delivered = async (address: string, signal: AbortSignal): Promise<MaildevEmail[]> => {
    const all = await call<MaildevEmail[]>('email', signal);
    return all.filter((email) => recipients(email).includes(address));
  };

  /** MailDev's health endpoint, under a budget of its own; a MailDev that never answers is named as not running. */
  const checkHealth = async (): Promise<void> => {
    const health = AbortSignal.timeout(HEALTH_CHECK_MS);
    try {
      await call('healthz', health);
    } catch (cause) {
      reachable = undefined;
      if (!health.aborted) throw cause;
      throw new Error(`MailDev is not answering at ${url} (no answer to GET /api/healthz within ${HEALTH_CHECK_MS}ms); start it before the run, e.g. npx maildev, or pass maildev({ url })`, { cause });
    }
  };

  return {
    name: 'maildev',
    async acquire({ signal }) {
      // One look before the first address, so a MailDev nobody started fails here, naming the fix, rather than as a wait that times out.
      // Shared by every caller, so it runs under a budget of its own rather than the first caller's signal.
      reachable ??= checkHealth();
      await withAbort(reachable, signal, () => signal.reason as Error);
      const address = `e2e-${randomBytes(6).toString('hex')}@${domain}`.toLowerCase();
      live.add(address);
      return { address };
    },
    async release(lease, { signal }) {
      live.delete(lease.address);
      const ids = (await delivered(lease.address, signal)).filter((email) => !recipients(email).some((address) => live.has(address))).map((email) => email.id);
      if (ids.length > 0) await call('email/delete', signal, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
    },
    list: async (lease, { signal }) => (await delivered(lease.address, signal)).map(summary),
    async read(_lease, id, { signal }): Promise<MailMessage> {
      const email = await call<MaildevEmail>(`email/${encodeURIComponent(id)}`, signal);
      return { ...summary(email), text: email.text, html: email.html };
    },
  };
}

/** The addresses a message went to, lowercased: its envelope (which holds Bcc), then To and Cc. */
function recipients(email: MaildevEmail): string[] {
  return [...(email.envelope?.to ?? []), ...(email.to ?? []), ...(email.cc ?? [])].map((party) => party.address.toLowerCase());
}

function summary(email: MaildevEmail): MailSummary {
  return {
    id: email.id,
    from: (email.from ?? []).map(spell).join(', '),
    to: (email.to ?? []).map(spell),
    cc: (email.cc ?? []).map(spell),
    subject: email.subject ?? '',
    receivedAt: new Date(email.time),
  };
}

/** A party as a header spells it: `Acme <noreply@acme.test>`, or the bare address. */
function spell(party: MaildevAddress): string {
  return party.name === undefined || party.name === '' ? party.address : `${party.name} <${party.address}>`;
}
