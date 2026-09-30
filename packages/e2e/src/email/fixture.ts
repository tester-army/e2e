/**
 * The `email` fixture: new addresses for the test body, over the attempt's
 * mail. Every call runs under the running phase's signal, read when it is
 * made, so an inbox a serial group's first member leased stops with the
 * member that is waiting on it.
 */

import type { Email, Inbox } from './types.ts';
import { waitTimeout, type AttemptMail, type Mailbox } from './mailbox.ts';

/** Builds the fixture over the attempt's mail. */
export function createEmailFixture(mail: AttemptMail): Email {
  return {
    inbox: async () => inboxOf(await mail.lease(mail.signal()), mail),
  };
}

function inboxOf(mailbox: Mailbox, mail: AttemptMail): Inbox {
  return {
    address: mailbox.address,
    messages: (filter = {}) => mailbox.messages(filter, mail.signal()),
    waitForMessage: async (filter = {}) => {
      const { timeout, ...match } = filter;
      return mailbox.waitForMessage(match, waitTimeout(timeout), mail.signal());
    },
  };
}
