import { test } from '@e2e-dev/web';
import { expect, type EmailMessage, type Screen } from 'e2e';

/** The six-digit code a verification email carries; the test knows the template, the runner does not. */
function codeIn(message: EmailMessage): string {
  const code = /verification code is (\d{6})/.exec(message.text)?.[1];
  expect(code, `no code in ${JSON.stringify(message.text)}`).toBeDefined();
  return code!;
}

/** Signs `address` up, so the scenario mails it a code. */
async function signUp(screen: Screen, address: string): Promise<void> {
  await screen.getByLabel('Email', { exact: true }).fill(address);
  await screen.getByRole('button', { name: 'Sign up' }).click();
  await expect(screen.getByLabel('Sign-up state')).toHaveText(`We sent a code to ${address}`);
}

test.describe('email verification', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/email-verification');
  });

  test('verifies a new account with the emailed code', async ({ screen, email }) => {
    const inbox = await email.inbox();
    await signUp(screen, inbox.address);

    const message = await inbox.waitForMessage({ from: 'noreply@benchmark.test', subject: 'Verify your email' });
    expect(message.to).toEqual([inbox.address]);
    expect(message.from).toBe('Benchmark <noreply@benchmark.test>');
    expect(message.html).toContain('<b>');
    await screen.getByLabel('Verification code').fill(codeIn(message));
    await screen.getByRole('button', { name: 'Verify' }).click();

    await expect(screen.getByTestId('success-message')).toHaveText(`Email verified for ${inbox.address}`);
  });

  test('a resent code replaces the first, and each wait returns the next email', async ({ screen, email }) => {
    const inbox = await email.inbox();
    await signUp(screen, inbox.address);
    const first = await inbox.waitForMessage({ subject: 'verify' });
    await screen.getByRole('button', { name: 'Resend code' }).click();
    await expect(screen.getByLabel('Sign-up state')).toHaveText(`We sent a new code to ${inbox.address}`);
    const second = await inbox.waitForMessage({ subject: 'verify' });

    expect(second.id).not.toBe(first.id);
    expect(codeIn(second)).not.toBe(codeIn(first));
    expect(await inbox.messages({ subject: /^Verify your email$/ })).toHaveLength(2);

    await screen.getByLabel('Verification code').fill(codeIn(first));
    await screen.getByRole('button', { name: 'Verify' }).click();
    await expect(screen.getByLabel('Sign-up state')).toHaveText('That code is not valid');
    await screen.getByLabel('Verification code').fill(codeIn(second));
    await screen.getByRole('button', { name: 'Verify' }).click();
    await expect(screen.getByTestId('success-message')).toHaveText(`Email verified for ${inbox.address}`);
  });

  test('signs in from the link in an HTML-only email', async ({ app, screen, email }) => {
    const inbox = await email.inbox();
    await screen.getByLabel('Sign-in email').fill(inbox.address);
    await screen.getByRole('button', { name: 'Email me a link' }).click();

    const message = await inbox.waitForMessage({ subject: 'sign-in link', text: 'Sign in to Benchmark' });
    // `text` is the HTML as a reader sees it: each link's URL after its label, Outlook-only markup left out.
    expect(message.html).toContain('>Sign in to Benchmark</a>');
    expect(message.text).not.toContain('Outlook preview');
    const link = /Sign in to Benchmark <(https?:\/\/[^\s>]+\?token=[0-9a-f]+)>/.exec(message.text)?.[1];
    expect(link, message.text).toBeDefined();

    await app.open(link!);
    await expect(screen.getByLabel('Sign-in state')).toHaveText(`Signed in as ${inbox.address}`);
  });

  test('an invite reaches the teammate, its Bcc copy only the sender, and nobody else', async ({ screen, email }) => {
    const me = await email.inbox();
    const teammate = await email.inbox();
    // Another account the app mails too, so its inbox is live and only the invite is missing from it.
    const bystander = await email.inbox();
    await signUp(screen, bystander.address);
    await bystander.waitForMessage({ subject: 'Verify your email' });
    await screen.getByLabel('Your email').fill(me.address);
    await screen.getByLabel("Teammate's email").fill(teammate.address);
    await screen.getByRole('button', { name: 'Send invite' }).click();
    await expect(screen.getByLabel('Invite state')).toHaveText(`Invite sent to ${teammate.address}, with a copy to you`);

    const invite = await teammate.waitForMessage({ subject: 'invited you' });
    expect(invite.subject).toBe(`${me.address} invited you to Benchmark`);
    // The copy names only the teammate in its headers; MailDev's envelope says it reached this address.
    const copy = await me.waitForMessage({ subject: 'invited you' });
    expect(copy.to).toEqual([teammate.address]);
    expect(await bystander.messages({ subject: 'invited you' })).toEqual([]);
    expect(await bystander.messages()).toHaveLength(1);
  });

  test('a wait for an email that never comes fails naming what did arrive', async ({ screen, email }) => {
    const inbox = await email.inbox();
    await signUp(screen, inbox.address);
    await inbox.waitForMessage({ subject: 'Verify your email' });

    const failure = await inbox.waitForMessage({ subject: 'Welcome aboard', timeout: 2_000 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: `no new email to ${inbox.address} matching subject "Welcome aboard" within 2000ms; 1 other email arrived: "Verify your email" from Benchmark <noreply@benchmark.test>`,
    });
  });
});
