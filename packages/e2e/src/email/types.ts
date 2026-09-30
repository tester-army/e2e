/** Public email types: the `email` fixture and the provider seam behind `config.email`. */

import type { TextMatch } from '../types.ts';

/**
 * The attempt's email: new addresses from the configured provider, each
 * given back when the attempt ends (a serial group's, when the group ends),
 * pass or fail. The agent's email tools share it: an address either side
 * created is readable by both, and an email one side's wait returned is not
 * returned to the other's.
 */
export interface Email {
  /** A new address nobody else receives mail at. A provider that cannot create one is `EMAIL_PROVIDER_FAILED`. */
  inbox(): Promise<Inbox>;
}

/** One email address and what arrived there. */
export interface Inbox {
  /** The address to type into the app. */
  readonly address: string;
  /** Every email received so far that matches, oldest first. Waits for nothing. */
  messages(filter?: EmailFilter): Promise<readonly EmailMessage[]>;
  /**
   * The oldest matching email no earlier wait returned, waiting for it to
   * arrive: two waits with the same filter return the first email and then
   * the second, so a test that triggers a resend waits again for the new
   * one. Nothing arriving within `timeout` (default 30000 ms) is
   * `ASSERTION_FAILED`, naming what did arrive.
   */
  waitForMessage(filter?: EmailFilter & { readonly timeout?: number }): Promise<EmailMessage>;
}

/** Which emails a read returns: a string is a case-insensitive substring, a RegExp is tested as is. */
export interface EmailFilter {
  readonly from?: TextMatch;
  readonly subject?: TextMatch;
  /** Tested against the email's `text`. */
  readonly text?: TextMatch;
}

/**
 * One received email. The runner reads no codes or links out of it: a test
 * takes what it needs from `text` or `html` with its own pattern, and the
 * agent reads the email the way a person does.
 */
export interface EmailMessage {
  readonly id: string;
  /** The sender as the message spells it: `Acme <noreply@acme.com>` or a bare address. */
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /**
   * What a reader sees: the HTML part's visible text, each link's URL after
   * its label as `<https://...>`, with hidden elements, comments, styles, and
   * scripts left out; the plain-text part for an email with no HTML part.
   * Filters and the agent read this same text.
   */
  readonly text: string;
  readonly html: string | undefined;
  readonly receivedAt: Date;
}

/**
 * Where `config.email` addresses come from and how their mail is read. The
 * runner owns everything a test and the agent see (filters, waits, retries,
 * the tools, what the model is shown); a provider only hands out addresses,
 * lists and reads what arrived, and gives addresses back, so a local SMTP catcher, a hosted inbox service, or
 * a mail server of your own plugs in the same way. Like every live value, a provider never
 * crosses a process boundary: each worker constructs its own.
 *
 * Every failure is `EMAIL_PROVIDER_FAILED`. During a wait, a failed `list`
 * or `read` is retried until the wait's deadline, unless the error carries
 * `retryable: false` (a rejected key, an exhausted quota).
 */
export interface MailProvider<Lease extends MailLease = MailLease> {
  /** Label in error messages and the config digest. */
  readonly name: string;
  /** A new address, for `email.inbox()` or the agent's `new_email_address`. */
  acquire(context: MailContext): Promise<Lease>;
  /** Gives an address back once its attempt ends, pass or fail: deletes what was created for it and the mail it received. */
  release(lease: Lease, context: MailContext): Promise<void>;
  /** Every message received at exactly the lease's address, oldest first. */
  list(lease: Lease, context: MailContext): Promise<readonly MailSummary[]>;
  /** One listed message with its body. */
  read(lease: Lease, id: string, context: MailContext): Promise<MailMessage>;
}

/**
 * One address a provider handed out; `release`, `list`, and `read` get this
 * same object back, so a provider keeps its own handles (an inbox id) on it.
 */
export interface MailLease {
  /** The address. */
  readonly address: string;
}

/** Handed to every provider call. */
export interface MailContext {
  /** Aborts when the wait, the tool call, or the cleanup budget is spent. */
  readonly signal: AbortSignal;
  /** The run the call belongs to, for tagging what the provider creates. */
  readonly runId: string;
}

/** One received message as a listing returns it: enough to filter on, no body. */
export interface MailSummary {
  readonly id: string;
  /** The sender as the message spells it: `Acme <noreply@acme.com>` or a bare address. */
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[] | undefined;
  readonly subject: string;
  readonly receivedAt: Date;
}

/** One received message with its body. */
export interface MailMessage extends MailSummary {
  readonly text?: string | undefined;
  readonly html?: string | undefined;
}
