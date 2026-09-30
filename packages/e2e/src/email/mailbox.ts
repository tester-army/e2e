/**
 * The attempt's mail: every address it leased from `config.email`, what reads
 * each one, and the release when the attempt ends. The `email` fixture and
 * the agent's email tools share one `AttemptMail`: an address either side
 * leased is readable by both, an email one side's wait returned is taken for
 * both, and the tools refuse every other address, so an agent talked into it
 * by the app under test cannot read mail the attempt never asked for.
 *
 * It lives as long as the attempt's session, so a serial group's members,
 * which share one session, share its addresses too: the account a member
 * signed up with is still readable by the next one. Each member rebinds the
 * signal its waits run under, so a wait always stops with the member running
 * it, whichever member leased the address.
 *
 * The agent's tools see only the attempt (`StepExecutorContext.attempt`), so
 * the mail is found by attempt, and the runner closes it by session, the
 * object whose lifetime it shares.
 *
 * Every provider call goes through one boundary: its failure is
 * `EMAIL_PROVIDER_FAILED`, and a cancellation stays `CANCELLED`.
 */

import type { ExecutorAttempt } from '../agent/executor.ts';
import { E2EError, errorMessage, InfrastructureError, TestError } from '../internal/errors.ts';
import { Deadline, sleep, withAbort } from '../internal/time.ts';
import { describeMatch, matchesField, toEmailMessage } from './message.ts';
import type { EmailFilter, EmailMessage, MailContext, MailLease, MailProvider } from './types.ts';

/** Default wait deadline: a transactional provider's queue plus delivery. */
export const DEFAULT_WAIT_TIMEOUT = 30_000;

/** Polling starts here and backs off to the cap: mail takes seconds, and a hosted API rate-limits tight loops. */
const FIRST_POLL_MS = 1_000;
const MAX_POLL_MS = 3_000;

/** How long a lease that landed after its caller gave up may take to go back. */
const LATE_RELEASE_MS = 30_000;

/** A provider call that failed; `providerRetryable` unless the provider said a retry will not help. */
class EmailProviderError extends InfrastructureError {
  constructor(
    message: string,
    readonly providerRetryable: boolean,
    cause?: unknown,
  ) {
    super('EMAIL_PROVIDER_FAILED', message, cause === undefined ? {} : { cause });
  }
}

/** Runs one provider call under `signal`: a failure becomes `EMAIL_PROVIDER_FAILED`, carrying the provider's `retryable`. */
async function providerCall<T>(provider: MailProvider, doing: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  try {
    return await withAbort(run, signal, cancelled);
  } catch (cause) {
    if (signal.aborted || (cause instanceof E2EError && cause.code === 'CANCELLED')) throw cancelled();
    const retryable = (cause as { retryable?: unknown } | null)?.retryable !== false;
    throw new EmailProviderError(`email provider "${provider.name}" failed ${doing}: ${errorMessage(cause)}`, retryable, cause);
  }
}

function cancelled(): E2EError {
  return new E2EError('infrastructure', 'CANCELLED', 'operation cancelled');
}

/** One leased address and what reads it. */
export class Mailbox {
  /** Emails a wait already returned, so the next wait returns the next one. */
  private readonly taken = new Set<string>();
  private readonly emails = new Map<string, EmailMessage>();

  constructor(
    private readonly mail: AttemptMail,
    readonly lease: MailLease,
  ) {}

  get address(): string {
    return this.lease.address;
  }

  /**
   * Every email received so far that matches, oldest first. One deleted
   * between listing and reading is left out rather than failing the read of
   * every other; a read the provider refuses for anything else fails.
   */
  async messages(filter: EmailFilter, signal: AbortSignal): Promise<EmailMessage[]> {
    const { provider } = this.mail;
    const context = this.mail.context(signal);
    const summaries = await providerCall(provider, `listing ${this.address}`, signal, () => provider.list(this.lease, context));
    const emails: EmailMessage[] = [];
    for (const summary of summaries) {
      if (!matchesField(summary.from, filter.from) || !matchesField(summary.subject, filter.subject)) continue;
      let email = this.emails.get(summary.id);
      if (email === undefined) {
        try {
          email = toEmailMessage(await providerCall(provider, `reading ${summary.id}`, signal, () => provider.read(this.lease, summary.id, context)));
        } catch (cause) {
          if (!(cause instanceof EmailProviderError && !cause.providerRetryable)) throw cause;
          const listed = await providerCall(provider, `listing ${this.address}`, signal, () => provider.list(this.lease, context));
          if (listed.some((candidate) => candidate.id === summary.id)) throw cause;
          continue;
        }
        this.emails.set(summary.id, email);
      }
      if (matchesField(email.text, filter.text)) emails.push(email);
    }
    return emails;
  }

  /**
   * The oldest matching email no earlier wait returned, polling until
   * `timeout` runs out. A failed poll is retried within the deadline unless
   * the provider said it will not pass; a wait cancelled before it returns
   * takes nothing. A timeout names what the last poll saw, without asking
   * the provider again.
   */
  async waitForMessage(filter: EmailFilter, timeout: number, signal: AbortSignal): Promise<EmailMessage> {
    const deadline = new Deadline(timeout);
    let interval = FIRST_POLL_MS;
    let failure: EmailProviderError | undefined;
    let seen: EmailMessage[] = [];
    for (;;) {
      // Each poll is cut at the deadline, but gets at least a second: a
      // `timeout: 0` wait and the last look after sleeping to the deadline
      // still ask once, so a provider that stops answering holds the wait at
      // most that second past its timeout.
      const budget = Math.max(deadline.remaining(), FIRST_POLL_MS);
      const poll = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
      try {
        seen = await this.messages({}, poll);
        failure = undefined;
        const next = seen.find((email) => matchesAll(email, filter) && !this.taken.has(email.id));
        if (next !== undefined) {
          if (signal.aborted) throw cancelled();
          this.taken.add(next.id);
          return next;
        }
      } catch (cause) {
        if (signal.aborted) throw cancelled();
        if (poll.aborted) failure = new EmailProviderError(`email provider "${this.mail.provider.name}" did not answer listing ${this.address} within ${budget}ms`, true);
        else if (cause instanceof EmailProviderError && cause.providerRetryable) failure = cause;
        else throw cause;
      }
      if (deadline.expired()) {
        if (failure !== undefined) throw failure;
        throw this.timedOut(filter, timeout, seen);
      }
      await sleep(Math.min(interval, deadline.remaining()), signal);
      interval = Math.min(interval * 1.5, MAX_POLL_MS);
    }
  }

  private timedOut(filter: EmailFilter, timeout: number, seen: readonly EmailMessage[]): TestError {
    const wanted = describeFilter(filter);
    const matching = seen.filter((email) => this.taken.has(email.id) && matchesAll(email, filter)).length;
    const others = seen.filter((email) => !matchesAll(email, filter));
    const arrived =
      seen.length === 0
        ? 'no email arrived'
        : [
            matching > 0 ? `${matching} matching ${matching === 1 ? 'email was' : 'emails were'} already returned by an earlier wait` : '',
            others.length > 0 ? `${others.length} other ${others.length === 1 ? 'email' : 'emails'} arrived: ${others.slice(-5).map((email) => `${JSON.stringify(email.subject)} from ${email.from}`).join(', ')}` : '',
          ]
            .filter((part) => part !== '')
            .join('; ');
    return new TestError('ASSERTION_FAILED', this.mail.redact(`no new email to ${this.address}${wanted === '' ? '' : ` matching ${wanted}`} within ${timeout}ms; ${arrived}`), {
      details: { expected: wanted === '' ? 'an email' : wanted, observed: this.mail.redact(arrived), waitedMs: timeout },
    });
  }
}

function matchesAll(email: EmailMessage, filter: EmailFilter): boolean {
  return matchesField(email.from, filter.from) && matchesField(email.subject, filter.subject) && matchesField(email.text, filter.text);
}

function describeFilter(filter: EmailFilter): string {
  const parts = (['from', 'subject', 'text'] as const).flatMap((field) => {
    const match = filter[field];
    return match === undefined ? [] : [`${field} ${describeMatch(match)}`];
  });
  return parts.join(', ');
}

/** Values the agent's email tools showed it that the attempt remembers; past this, the oldest are forgotten first. */
const MAX_EVIDENCE = 4_000;

/** Every address one attempt (or serial group) leased, by address. */
export class AttemptMail {
  private readonly mailboxes = new Map<string, Mailbox>();
  /** Leases still landing; closing waits for them, so one that lands then is released rather than lost. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Releases that failed outside `close` (a lease that landed after its caller gave up), reported by it. */
  private readonly lateFailures: Error[] = [];
  private closed = false;
  /**
   * What the agent's email tools showed it: addresses, the lines of each
   * email, and the URLs in them. A value typed or navigated to later in the
   * attempt that came from here is this run's data, which the replay cache
   * must not record as the flow's (`derivedReason`), whichever step read it.
   */
  readonly evidence = new Set<string>();

  constructor(
    readonly provider: MailProvider,
    private readonly runId: string,
    /** The attempt's secret ledger: what a tool shows the model passes through it. */
    readonly redact: (text: string) => string,
    private phaseSignal: () => AbortSignal,
  ) {}

  /** Points the fixture's calls at the running attempt's phase signal; a serial member rebinds it. */
  bind(signal: () => AbortSignal): void {
    this.phaseSignal = signal;
  }

  /** The running phase's signal, read at call time. */
  signal(): AbortSignal {
    return this.phaseSignal();
  }

  context(signal: AbortSignal): MailContext {
    return { signal, runId: this.runId };
  }

  /**
   * Leases a new address. The provider's call is followed to its end
   * whatever the caller does: a lease that lands after its caller gave up (a
   * test that timed out mid-acquire) or after the attempt closed goes
   * straight back, so no address outlives the attempt.
   */
  async lease(signal: AbortSignal): Promise<Mailbox> {
    if (this.closed) throw cancelled();
    const acquiring = Promise.resolve().then(() => this.provider.acquire(this.context(signal)));
    const landed = acquiring.then(
      (lease) => this.land(lease, signal),
      () => undefined,
    );
    this.pending.add(landed);
    void landed.finally(() => this.pending.delete(landed));
    await providerCall(this.provider, 'creating an address', signal, () => acquiring);
    const mailbox = await landed;
    if (mailbox === undefined) throw cancelled();
    return mailbox;
  }

  /** Registers a lease that landed, or gives it back when nobody can use it any more. */
  private async land(lease: MailLease, signal: AbortSignal): Promise<Mailbox | undefined> {
    const mailbox = new Mailbox(this, lease);
    if (this.closed || signal.aborted) {
      await this.releaseOne(mailbox, AbortSignal.timeout(LATE_RELEASE_MS)).catch((cause: unknown) => this.lateFailures.push(cause as Error));
      return undefined;
    }
    this.mailboxes.set(key(lease.address), mailbox);
    return mailbox;
  }

  /** The mailbox of an address this attempt leased, or undefined for any other address. */
  find(address: string): Mailbox | undefined {
    return this.mailboxes.get(key(address));
  }

  /** Remembers what a tool showed the model; see `evidence`. The newest values win when it is full. */
  remember(values: Iterable<string>): void {
    for (const value of values) {
      if (value.trim() === '') continue;
      this.evidence.delete(value);
      this.evidence.add(value);
      if (this.evidence.size > MAX_EVIDENCE) this.evidence.delete(this.evidence.values().next().value!);
    }
  }

  /**
   * Gives every address back, in parallel, within `signal`; the failures,
   * one per address that did not go back. Leases still being acquired are
   * waited for as long as `signal` allows, and one that lands meanwhile goes
   * back too; a hung acquire holds back no address that already landed.
   */
  async close(signal: AbortSignal): Promise<Error[]> {
    this.closed = true;
    const mailboxes = [...this.mailboxes.values()];
    this.mailboxes.clear();
    const [released] = await Promise.all([
      Promise.allSettled(mailboxes.map((mailbox) => this.releaseOne(mailbox, signal))),
      withAbort(Promise.allSettled(this.pending), signal, cancelled).catch(() => undefined),
    ]);
    return [...released.flatMap((result) => (result.status === 'rejected' ? [result.reason as Error] : [])), ...this.lateFailures.splice(0)];
  }

  private releaseOne(mailbox: Mailbox, signal: AbortSignal): Promise<void> {
    return providerCall(this.provider, `releasing ${mailbox.address}`, signal, () => this.provider.release(mailbox.lease, this.context(signal)));
  }
}

function key(address: string): string {
  return address.trim().toLowerCase();
}

/** By session: a serial group's members share one. */
const bySession = new WeakMap<object, AttemptMail>();
/** By attempt: what the agent's tools and the dispatcher, which see only the attempt, reach it through. */
const byAttempt = new WeakMap<ExecutorAttempt, AttemptMail>();

/** The mail of the attempt running on `session`, created on first use, its calls bound to `signal`. */
export function attemptMail(
  session: object,
  attempt: ExecutorAttempt,
  options: { readonly provider: MailProvider; readonly runId: string; readonly redact: (text: string) => string; readonly signal: () => AbortSignal },
): AttemptMail {
  let mail = bySession.get(session);
  if (mail === undefined) {
    mail = new AttemptMail(options.provider, options.runId, options.redact, options.signal);
    bySession.set(session, mail);
  } else {
    mail.bind(options.signal);
  }
  byAttempt.set(attempt, mail);
  return mail;
}

/** The mail an attempt's fixtures set up; undefined when the config names no email. */
export function mailOfAttempt(attempt: ExecutorAttempt): AttemptMail | undefined {
  return byAttempt.get(attempt);
}

/** Releases the addresses leased on `session`, once it closes, within `signal`; the release failures. */
export async function releaseSessionMail(session: object, signal: AbortSignal): Promise<Error[]> {
  const mail = bySession.get(session);
  if (mail === undefined) return [];
  bySession.delete(session);
  return mail.close(signal);
}

/** A deadline in milliseconds from an option, validated. */
export function waitTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_WAIT_TIMEOUT;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TestError('INVALID_ARGUMENT', `timeout must be a non-negative number of milliseconds, got ${String(timeout)}`);
  }
  return timeout;
}
