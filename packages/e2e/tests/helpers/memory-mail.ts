/** A `MailProvider` over an in-memory mail store, the shape a local SMTP catcher has, for the email fixture and tools tests. */

import type { MailLease, MailMessage, MailProvider } from '../../src/email/types.ts';

export interface MemoryProvider extends MailProvider {
  readonly acquired: string[];
  readonly released: string[];
  /** Delivers an email to `to`; `message.to` is its To header when that names someone else (a Bcc copy). */
  deliver(to: string, message: { from?: string; to?: string[]; subject?: string; text?: string; html?: string }): MailMessage;
}

/** An in-memory provider: addresses `user<n>@memory.test`, mail kept per address. */
export function memoryProvider(): MemoryProvider {
  const mail = new Map<string, MailMessage[]>();
  let counter = 0;
  const provider: MemoryProvider = {
    name: 'memory',
    acquired: [],
    released: [],
    deliver(to, message) {
      counter += 1;
      const delivered: MailMessage = {
        id: `m${counter}`,
        from: message.from ?? 'Acme <noreply@acme.test>',
        to: message.to ?? [to],
        subject: message.subject ?? '',
        receivedAt: new Date(1_790_000_000_000 + counter * 1000),
        text: message.text,
        html: message.html,
      };
      const box = mail.get(to);
      if (box === undefined) throw new Error(`nobody leased ${to}`);
      box.push(delivered);
      return delivered;
    },
    async acquire() {
      counter += 1;
      const address = `user${counter}@memory.test`;
      mail.set(address, []);
      provider.acquired.push(address);
      return { address };
    },
    async release(lease: MailLease) {
      provider.released.push(lease.address);
      mail.delete(lease.address);
    },
    async list(lease) {
      return (mail.get(lease.address) ?? []).map(({ text: _text, html: _html, ...summary }) => summary);
    },
    async read(lease, id) {
      const message = mail.get(lease.address)?.find((candidate) => candidate.id === id);
      if (message === undefined) throw new Error(`no message ${id}`);
      return message;
    },
  };
  return provider;
}
