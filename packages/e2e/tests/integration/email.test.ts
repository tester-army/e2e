/**
 * `config.email` through the real runner and a real browser: a signup page
 * that mails a code to the address it is given, delivered into an in-memory
 * provider. The `email` fixture signs up deterministically; the built-in
 * agent, scripted, signs up with `new_email_address` and `wait_for_email`.
 * Every leased address goes back to the provider when its attempt ends, and a
 * test that reaches for `email` with no provider configured is told how.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeLoopModel, loopCalls, nodeIdFor, type LoopCall } from '../helpers/fake-loop-model.ts';
import { memoryProvider, type MemoryProvider } from '../helpers/memory-mail.ts';
import { resultByTitle, runExisting, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

/** A signup page: POST an address, get a code by email, POST the code back. */
async function startSignupApp(mail: MemoryProvider): Promise<{ url: string; close: () => Promise<void> }> {
  const codes = new Map<string, string>();
  let issued = 0;
  const page = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
  const server: Server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const form = new URLSearchParams(raw);
    response.setHeader('content-type', 'text/html');
    if (request.method === 'POST' && request.url === '/signup') {
      const address = form.get('email') ?? '';
      issued += 1;
      const code = String(482_900 + issued);
      codes.set(address, code);
      const link = `http://${request.headers.host ?? '127.0.0.1'}/magic?token=t${code}`;
      mail.deliver(address, { subject: 'Verify your email', text: `Your code is ${code}.\n\nAcme, 2026`, html: `<p>Your code is <b>${code}</b>.</p><p><a href="${link}">Sign in</a></p>` });
      response.end(page(`<h1>Check your inbox</h1><form method="post" action="/verify"><input type="hidden" name="email" value="${address}"><label>Code <input name="code"></label><button>Verify</button></form>`));
      return;
    }
    if (request.method === 'POST' && request.url === '/verify') {
      const ok = codes.get(form.get('email') ?? '') === form.get('code');
      response.end(page(ok ? `<h1>Verified</h1><p>${form.get('email')} is verified.</p>` : '<h1>Wrong code</h1>'));
      return;
    }
    const magic = /^\/magic\?token=t(\d+)$/u.exec(request.url ?? '');
    if (magic !== null) {
      response.end(page([...codes.values()].includes(magic[1]!) ? '<h1>Signed in</h1>' : '<h1>Link expired</h1>'));
      return;
    }
    response.end(page('<h1>Sign up</h1><form method="post" action="/signup"><label>Email <input name="email" type="email"></label><button>Sign up</button></form>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const SUITE = `import { expect, test } from 'e2e';

test('signs up with an inbox from the email fixture', async ({ app, screen, email }) => {
  const inbox = await email.inbox();
  await app.open('/');
  await screen.getByLabel('Email').fill(inbox.address);
  await screen.getByRole('button', { name: 'Sign up' }).click();
  const message = await inbox.waitForMessage({ subject: 'verify', timeout: 5000 });
  const [, code] = /Your code is (\\d{6})/.exec(message.text) ?? [];
  await screen.getByLabel('Code').fill(code);
  await screen.getByRole('button', { name: 'Verify' }).click();
  await expect(screen.getByText(inbox.address + ' is verified.')).toBeVisible();
});

test('the agent signs up with an address of its own', async ({ app, agent, screen }) => {
  await app.open('/');
  await agent.act('sign up with a new email address and verify it with the emailed code');
  await expect(screen.getByRole('heading', { name: 'Verified' })).toBeVisible();
});

test('fails naming what arrived when the expected email never does', async ({ app, screen, email }) => {
  const inbox = await email.inbox();
  await app.open('/');
  await screen.getByLabel('Email').fill(inbox.address);
  await screen.getByRole('button', { name: 'Sign up' }).click();
  await inbox.waitForMessage({ subject: 'Welcome aboard', timeout: 1500 });
});
`;

/** The agent's turns: mint an address, sign up with it, read the code, and enter it. */
function signupModel(call: LoopCall) {
  const results = call.toolResults;
  const address = /New email address: (\S+)/u.exec(results.join('\n'))?.[1] ?? '';
  const code = /Your code is (\d{6})/u.exec(results.join('\n'))?.[1];
  const screens = [call.prompt, ...results].join('\n');
  switch (call.turn) {
    case 1:
      return [{ toolName: 'new_email_address', input: {} }];
    case 2:
      return [{ toolName: 'type', input: { target: nodeIdFor(call.prompt, /textbox "Email"/u), value: address } }];
    case 3:
      return [{ toolName: 'tap', input: { target: nodeIdFor(screens, /button "Sign up"/u) } }];
    case 4:
      return [{ toolName: 'wait_for_email', input: { address, subject: 'verify', timeout_seconds: 5 } }];
    case 5:
      return [{ toolName: 'type', input: { target: nodeIdFor(screens, /textbox "Code"/u), value: code } }];
    case 6:
      return [{ toolName: 'tap', input: { target: nodeIdFor(screens, /button "Verify"/u) } }];
    default:
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: `verified ${address}` } }];
  }
}

describe('config.email', () => {
  const mail = memoryProvider();
  let app: { url: string; close: () => Promise<void> };
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startSignupApp(mail);
    const model = installFakeLoopModel(signupModel);
    const run = await runProject(
      {
        'tests/email.e2e.ts': SUITE,
        'tests/own-email.e2e.ts': `import { test as base } from 'e2e';\n\nconst test = base.extend({ email: async (_fixtures, use) => use('own@acme.test') });\n\ntest('redefines the runner email fixture', async () => {});\n`,
      },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', workers: 1, cache: 'off', email: mail, agents: { default: { model } } } },
    );
    outcome = run.outcome;
    project = run.project;
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('signs up through the email fixture', () => {
    const result = resultByTitle(outcome, 'signs up with an inbox from the email fixture');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it('offers the agent the email tools and signs up through them', () => {
    const result = resultByTitle(outcome, 'the agent signs up with an address of its own');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    expect(loopCalls[0]!.toolNames).toEqual(expect.arrayContaining(['new_email_address', 'wait_for_email']));
    const read = loopCalls[4]!.lastToolResult;
    expect(read).toContain('<email>\nFrom: Acme <noreply@acme.test>');
    expect(read).toContain('Subject: Verify your email');
    expect(read).toMatch(/Your code is \d{6}\./u);
  });

  it('fails a wait that times out with ASSERTION_FAILED, naming the email that did arrive', () => {
    const result = resultByTitle(outcome, 'fails naming what arrived when the expected email never does');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringMatching(/matching subject "Welcome aboard" within 1500ms; 1 other email arrived: "Verify your email" from Acme <noreply@acme\.test>$/u),
    });
  });

  it('refuses a test.extend() fixture named email, which the runner contributes', () => {
    expect(resultByTitle(outcome, 'redefines the runner email fixture').attempts[0]!.error).toMatchObject({
      code: 'TEST_SETUP_FAILED',
      message: 'fixture "email" is contributed by the runner (a built-in fixture); test.extend() cannot redefine it',
    });
  });

  it('releases every address when its attempt ends, the agent\'s included', () => {
    expect(mail.acquired).toHaveLength(3);
    expect(mail.released.toSorted()).toEqual(mail.acquired.toSorted());
  });
});

/** The two-step flow's turns: step 1 mints an address, step 2 signs up with the one its ledger names. */
function twoStepModel(call: LoopCall) {
  const results = call.toolResults.join('\n');
  if (call.prompt.includes('Execute this test step: get a new email address')) {
    const minted = /New email address: (\S+)/u.exec(results)?.[1];
    return minted === undefined
      ? [{ toolName: 'new_email_address', input: {} }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: `got ${minted}` } }];
  }
  const address = /got (\S+@memory\.test)/u.exec(call.prompt)?.[1] ?? '';
  const code = /Your code is (\d{6})/u.exec(results)?.[1];
  const screens = [call.prompt, ...call.toolResults].join('\n');
  const done = call.toolResults.length;
  if (done === 0) return [{ toolName: 'type', input: { target: nodeIdFor(call.prompt, /textbox "Email"/u), value: address } }];
  if (done === 1) return [{ toolName: 'tap', input: { target: nodeIdFor(screens, /button "Sign up"/u) } }];
  if (done === 2) return [{ toolName: 'wait_for_email', input: { address, subject: 'verify', timeout_seconds: 5 } }];
  if (done === 3) return [{ toolName: 'type', input: { target: nodeIdFor(screens, /textbox "Code"/u), value: code } }];
  if (done === 4) return [{ toolName: 'tap', input: { target: nodeIdFor(screens, /button "Verify"/u) } }];
  return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'verified' } }];
}

describe('an address the agent got in an earlier step', () => {
  const mail = memoryProvider();
  let app: { url: string; close: () => Promise<void> };
  let project: FixtureProject;
  let second: RunOutcome;

  beforeAll(async () => {
    app = await startSignupApp(mail);
    const suite = `import { expect, test } from 'e2e';

test('signs up in two steps', async ({ app, agent, screen }) => {
  await app.open('/');
  await agent.act('get a new email address');
  await agent.act('sign up with it and verify it with the emailed code');
  await expect(screen.getByRole('heading', { name: 'Verified' })).toBeVisible();
});
`;
    const options = { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', workers: 1, cache: 'read-write' as const, email: mail, agents: { default: { model: installFakeLoopModel(twoStepModel) } } } };
    const first = await runProject({ 'tests/two-step.e2e.ts': suite }, options);
    project = first.project;
    expect(resultByTitle(first.outcome, 'signs up in two steps').status, JSON.stringify(resultByTitle(first.outcome, 'signs up in two steps').attempts[0]?.error)).toBe('passed');
    second = await runExisting(project, { ...options, config: { ...options.config, agents: { default: { model: installFakeLoopModel(twoStepModel) } } } });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('is never replayed: the next run types its own new address, not the recorded one', () => {
    const result = resultByTitle(second, 'signs up in two steps');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    const [, signUp] = result.attempts[0]!.steps.filter((step) => step.api === 'agent.act');
    expect(signUp!.cache).toMatchObject({ reason: 'gap', derived: 'whole-node', replayedActions: 0 });
    expect(mail.acquired).toHaveLength(2);
  });
});

/** Step 1 reads the email and names its link's path; step 2 opens that path, as a model may shorten a link on the app's origin. */
function linkModel(call: LoopCall) {
  if (call.prompt.includes('Execute this test step: read the verification email')) {
    const address = /"email":"([^"]+)"/u.exec(call.prompt)?.[1] ?? '';
    const path = /(\/magic\?token=t\d+)/u.exec(call.toolResults.join('\n'))?.[1];
    return path === undefined
      ? [{ toolName: 'wait_for_email', input: { address, subject: 'verify', timeout_seconds: 5 } }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: `the sign-in link is ${path}` } }];
  }
  const path = /the sign-in link is (\S+)/u.exec(call.prompt)?.[1] ?? '';
  return call.toolResults.length === 0
    ? [{ toolName: 'navigate', input: { url: path } }]
    : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'signed in' } }];
}

describe('a link the agent read in an earlier step, opened as a path', () => {
  const mail = memoryProvider();
  let app: { url: string; close: () => Promise<void> };
  let project: FixtureProject;
  let second: RunOutcome;

  beforeAll(async () => {
    app = await startSignupApp(mail);
    const suite = `import { expect, test, unique } from 'e2e';

test('signs in from the emailed link', async ({ app, agent, screen, email }) => {
  const inbox = await email.inbox();
  await app.open('/');
  await screen.getByLabel('Email').fill(inbox.address);
  await screen.getByRole('button', { name: 'Sign up' }).click();
  await agent.act('read the verification email sent to {email}', { params: { email: unique(inbox.address) } });
  await agent.act('open the sign-in link');
  await expect(screen.getByRole('heading', { name: 'Signed in' })).toBeVisible();
});
`;
    const config = (model: ReturnType<typeof installFakeLoopModel>) => ({ tests: 'tests/**/*.e2e.ts', workers: 1, cache: 'read-write' as const, email: mail, agents: { default: { model } } });
    const first = await runProject({ 'tests/link.e2e.ts': suite }, { appUrl: app.url, config: config(installFakeLoopModel(linkModel)) });
    project = first.project;
    const recorded = resultByTitle(first.outcome, 'signs in from the emailed link');
    expect(recorded.status, JSON.stringify(recorded.attempts[0]?.error)).toBe('passed');
    second = await runExisting(project, { appUrl: app.url, config: config(installFakeLoopModel(linkModel)) });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('is never replayed: the next run opens its own new link, not the recorded token', () => {
    const result = resultByTitle(second, 'signs in from the emailed link');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    const [, open] = result.attempts[0]!.steps.filter((step) => step.api === 'agent.act');
    expect(open!.cache).toMatchObject({ reason: 'gap', derived: 'whole-node', replayedActions: 0 });
  });
});

describe('the email fixture with no provider configured', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    const run = await runProject(
      {
        'tests/email.e2e.ts': `import { test } from 'e2e';\n\ntest('asks for an inbox', async ({ email }) => {\n  await email.inbox();\n});\n`,
        'tests/own-email.e2e.ts': `import { test as base } from 'e2e';\n\nconst test = base.extend<{ email: string }>({ email: async (_fixtures, use) => use('own@acme.test') });\n\ntest('defines a fixture of its own named email', async ({ email }) => {\n  if (email !== 'own@acme.test') throw new Error(email);\n});\n`,
      },
      { appUrl: 'http://127.0.0.1:9', config: { tests: 'tests/**/*.e2e.ts', workers: 1 } },
    );
    outcome = run.outcome;
    project = run.project;
  }, 120_000);

  afterAll(() => project?.cleanup());

  it('leaves the name free for a project fixture of its own', () => {
    const result = resultByTitle(outcome, 'defines a fixture of its own named email');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it('fails with UNSUPPORTED_CAPABILITY naming the config key', () => {
    expect(resultByTitle(outcome, 'asks for an inbox').attempts[0]!.error).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('set email in e2e.config.ts'),
    });
  });
});
