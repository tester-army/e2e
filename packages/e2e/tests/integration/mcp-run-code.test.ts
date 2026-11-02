/**
 * `run_code` end to end: the built CLI serving a fixture project over stdio
 * to a real MCP client, on the web engine and the fixture app. Statements
 * run on the session's fixtures with the test API's own waiting, matching,
 * and matchers; they stop at the first failure within the call's timeout;
 * code outside the grammar runs nothing. A Secret fills only under the
 * authorization `type_secret` runs, reads and matchers see redacted text, a
 * locator found by part of a text is refused in a project with secrets, a
 * password field stays unreadable, and screenshots stay on after a fill. The
 * statements that pass join `test_lines`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const PASSWORD = 'admin-pass-7Qz';
const API_KEY = 'sk-live-RUNCODE-0000';

const CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  credentials: { admin: { username: 'admin', password: ${JSON.stringify(PASSWORD)} } },
  secrets: { apiKey: ${JSON.stringify(API_KEY)} },
} satisfies E2EConfig;
`;

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
  readonly images: number;
}

describe('e2e mcp run_code', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;
  /** Every text a tool returned, to check no secret value ever left the server. */
  const returned: string[] = [];

  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const result = (await client.callTool({ name, arguments: args }, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    returned.push(text);
    return { text, isError: result.isError === true, images: result.content.filter((part) => part.type === 'image').length };
  };

  const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolText> => invoke('call', { tool, args });
  const runCode = (code: string, timeout?: number): Promise<ToolText> => call('run_code', { code, ...(timeout === undefined ? {} : { timeout }) });
  const nodeId = (text: string, pattern: RegExp): string => {
    const match = /#(n\d+)/.exec(text.split('\n').find((line) => pattern.test(line)) ?? '');
    if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
    return match[1]!;
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG });
    client = new Client({ name: 'e2e-mcp-run-code-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp'],
        cwd: project.dir,
        env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
        stderr: 'ignore',
      }),
    );
    const opened = await invoke('open_session');
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toMatch(/^- run_code \{code, timeout\?\}: Run e2e test code against the live session before writing it into a test\.$/m);
  }, 60_000);

  afterAll(async () => {
    await invoke('close_session').catch(() => undefined);
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it("runs a block on the session's fixtures with the test API's semantics, shows reads, and reports what changed", async () => {
    const result = await runCode(`await app.open('/');
await screen.getByRole('button', 'Increment').tap();
await expect(screen.getByRole('status', 'Counter')).toHaveText('1');
await screen.getByRole('status', 'Counter').textContent();
await screen.getByLabel('Plan').selectOption('Pro');
await expect(screen.getByLabel('Plan')).toHaveValue('pro');
await expect(screen.getByText('Late arrival')).toBeVisible();
await screen.getByTestId('item').allTextContents();`);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('All 8 statements passed.\n');
    expect(result.text).toContain("1. passed: await app.open('/');\n");
    expect(result.text).toContain("4. passed: await screen.getByRole('status', 'Counter').textContent();\n   returned \"1\"\n");
    expect(result.text).toContain('   returned ["Item Alpha","Item Beta","Item Gamma"]\n');
    expect(result.text).toMatch(/\n\n(?:Screen changes since revision|The screen changed substantially)/);
    expect(result.text).toContain('status "Counter" text="1"');

    const observed = await call('observe');
    expect(observed.text).toMatch(/combobox "Plan" value="pro"/);
  });

  it('stops at the first failure within the timeout, gives its code and message, and leaves the rest unrun', async () => {
    const started = Date.now();
    const missing = await runCode(
      `await screen.getByLabel('Emial').fill('ada@example.test');
await screen.getByRole('button', 'Increment').tap();`,
      500,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(
      /^Statement 1 of 2 failed, and the one after it did not run\. Each statement waited at most 500 ms\.\n1\. failed: await screen\.getByLabel\('Emial'\)\.fill\('ada@example\.test'\);\n {3}LOCATOR_NOT_FOUND: locator matched no nodes within getByLabel\("Emial"\)\n2\. not run: /,
    );
    expect(missing.text).toMatch(/\n\nScreen unchanged since revision/);

    const ambiguous = await runCode("await screen.getByRole('button', 'Increment').tap();\nawait screen.getByText('Duplicated').tap();\nawait app.back();");
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('Statement 2 of 3 failed; the one before it passed, and the one after it did not run. Each statement waited at most 5000 ms. The app is where the passing statements left it: run the fixed statement and the rest from here.');
    expect(ambiguous.text).toContain('LOCATOR_AMBIGUOUS: locator matched 2 nodes, expected exactly one: getByText("Duplicated")');

    const assertion = await runCode("await expect(screen.getByRole('status', 'Counter')).toHaveText('99');", 300);
    expect(assertion.isError).toBe(true);
    expect(assertion.text).toContain('ASSERTION_FAILED: expect.toHaveText failed\n   locator: getByRole("status", name: "Counter")\n   expected: text "99"\n   observed: text "2"');
  });

  it('refuses code outside the grammar before running any of it', async () => {
    const refused = await runCode("await screen.getByRole('button', 'Increment').tap();\nprocess.exit(1);");
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe('INVALID_ARGUMENT: run_code: "process" at 2:1 is not in the grammar; a statement starts with screen, app, or expect(...)');
    const evaluated = await runCode("await browser.evaluate('document.title')");
    expect(evaluated.text).toBe(
      'INVALID_ARGUMENT: run_code: "browser" at 1:7 is a fixture of this target\'s engine, which run_code does not run; a statement starts with screen, app, or expect(...)',
    );
    const unchanged = await runCode("await expect(screen.getByRole('status', 'Counter')).toHaveText('2')", 300);
    expect(unchanged.isError, unchanged.text).toBe(false);
  });

  it('adds the statements that passed to test_lines, reads and failures aside, and keeps the ids its screen listed', async () => {
    const drafted = await call('test_lines');
    expect(drafted.text.split('\n').filter((line) => line.startsWith('await '))).toEqual([
      'await app.open();',
      "await app.open('/');",
      "await screen.getByRole('button', 'Increment').tap();",
      "await expect(screen.getByRole('status', 'Counter')).toHaveText('1');",
      "await screen.getByLabel('Plan').selectOption('Pro');",
      "await expect(screen.getByLabel('Plan')).toHaveValue('pro');",
      "await expect(screen.getByText('Late arrival')).toBeVisible();",
      "await screen.getByRole('button', 'Increment').tap();",
      "await expect(screen.getByRole('status', 'Counter')).toHaveText('2');",
    ]);
    // The next action's test line is read from the screen run_code returned.
    const echo = await runCode("await app.open('/echo');");
    const typed = await call('type', { target: nodeId(echo.text, /textbox "Token"/), value: 'typed by id' });
    expect(typed.text.split('\n')[1]).toBe('Test line: await screen.getByRole("textbox", "Token").fill("typed by id");');
    const home = await runCode("await app.open('/');");
    expect(home.isError, home.text).toBe(false);
  });

  it('runs a locator built with or, as a test would', async () => {
    const either = await runCode("await expect(screen.getByRole('button', 'Increment').or(screen.getByRole('button', 'Nowhere'))).toBeVisible();");
    expect(either.isError, either.text).toBe(false);
    expect(either.text).toContain('The statement passed.\n');
  });

  describe('secrets', () => {
    it('fills a password only where type_secret would, and keeps the screenshot after the fill', async () => {
      const before = await call('screenshot');
      expect(before.images).toBe(1);

      const intoEmail = await runCode("await screen.getByLabel('Email').fill(credentials.user('admin').password);");
      expect(intoEmail.isError).toBe(true);
      expect(intoEmail.text).toContain('POLICY_DENIED: field purpose username is incompatible with secret purpose password');
      const intoButton = await runCode("await screen.getByRole('button', 'Increment').fill(secrets.get('apiKey'));");
      expect(intoButton.text).toContain('POLICY_DENIED: the target is not an editable input (role button)');
      const unconfigured = await runCode("await screen.getByLabel('Password').fill(credentials.user('ghost').password);");
      expect(unconfigured.text).toContain('AUTH_CREDENTIAL_UNAVAILABLE: credential "ghost" is not configured');
      const unknown = await runCode("await screen.getByLabel('Email').fill(secrets.get('stripeKey'));");
      expect(unknown.text).toContain('SECRET_UNAVAILABLE: secret "stripeKey" is not configured');
      const badOptions = await runCode("await screen.getByLabel('Password').fill(credentials.user('admin').password, { delay: 5 });");
      expect(badOptions.text).toContain('INVALID_ARGUMENT: fill options has no key "delay"; it takes timeout');
      const badTimeout = await runCode("await screen.getByLabel('Password').fill(credentials.user('admin').password, { timeout: '1s' });");
      expect(badTimeout.text).toContain('INVALID_ARGUMENT: fill timeout must be a number of milliseconds');
      const emailValue = await runCode("await screen.getByLabel('Email').inputValue()");
      expect(emailValue.text).toContain('returned ""');
      const signedIn = await runCode(`await screen.getByLabel('Email').fill(credentials.user('admin').username);
await screen.getByLabel('Password').fill(credentials.user('admin').password);`);
      expect(signedIn.isError, signedIn.text).toBe(false);
      expect(signedIn.text).toContain('All 2 statements passed.');
      const read = await runCode("await screen.getByLabel('Password').inputValue();");
      expect(read.isError).toBe(true);
      expect(read.text).toContain('POLICY_DENIED: reading values from a secure field is denied: getByLabel("Password")');
      const asserted = await runCode("await expect(screen.getByLabel('Password')).toHaveValue('guess')", 300);
      expect(asserted.text).toContain('POLICY_DENIED: reading values from a secure field is denied');

      const after = await call('screenshot');
      expect(after.images).toBe(1);
    });

    it('fills a generic secret into a plain field and redacts it from every read and failure', async () => {
      const filled = await runCode(`await app.open('/echo');
await screen.getByLabel('Token').fill(secrets.get('apiKey'));`);
      expect(filled.isError, filled.text).toBe(false);
      // The short timeout is for the assertion meant to fail; the open and the fill above need the default one under load.
      const echoed = await runCode(`await screen.getByLabel('Token').inputValue();
await screen.getByTestId('plain').textContent();
await screen.getByTestId('upper').allTextContents();
await expect(screen.getByTestId('plain')).toHaveText('nothing yet');`, 300);
      expect(echoed.isError).toBe(true);
      expect(echoed.text).toContain("1. passed: await screen.getByLabel('Token').inputValue();\n   returned \"<secret:apiKey>\"");
      expect(echoed.text).toContain("2. passed: await screen.getByTestId('plain').textContent();\n   returned \"<secret:apiKey>\"");
      expect(echoed.text).toContain('returned ["<secret:apiKey>"]');
      expect(echoed.text).toContain('4. failed:');
      expect(echoed.text).toContain('observed: text "<secret:apiKey>"');
    });

    it('compares matchers against redacted text, so no pass or fail depends on a secret', async () => {
      // The secret from the test before is still in the Token field and its echoes.
      for (const code of [
        "await expect(screen.getByTestId('plain')).toContainText('sk-live');",
        "await expect(screen.getByLabel('Token')).toHaveValue(/^sk-l/);",
        "await expect(screen.getByTestId('upper')).toHaveText(/SK-LIVE/i);",
      ]) {
        const probed = await runCode(code, 300);
        expect(probed.isError, code).toBe(true);
        expect(probed.text, code).toContain('ASSERTION_FAILED');
        expect(probed.text, code).toContain('<secret:apiKey>');
      }
      // A test compares the real value, so a line expecting the marker would pass here and fail there.
      const marker = await runCode("await screen.getByLabel('Note').fill('kept');\nawait expect(screen.getByTestId('plain')).toHaveText('<secret:apiKey>');");
      expect(marker.isError).toBe(true);
      expect(marker.text).toBe(
        "INVALID_ARGUMENT: run_code: statement 2 (await expect(screen.getByTestId('plain')).toHaveText('<secret:apiKey>');) expects <secret:name>, which only redacted text holds: a test compares the real value, so the line would fail there. Assert what the screen shows around the secret instead; nothing ran.",
      );
      const note = await runCode("await screen.getByLabel('Note').inputValue();");
      expect(note.text).toContain('returned ""');
    });

    it('refuses a locator found by part of a text in a project with secrets, before anything runs', async () => {
      for (const [code, statement] of [
        ["await screen.getByDisplayValue(/^sk-l/).count();", 1],
        ["await screen.getByText('sk-l', { exact: false }).count();", 1],
        ["await screen.getByText('sk-l', { exact: 0 }).count();", 1],
        ["await app.open('/echo');\nawait screen.getByTestId('plain').filter({ hasText: 'sk-l' }).count();", 2],
        ["await screen.getByRole('textbox', { name: /Token/ }).fill('typed');", 1],
        ["await expect(screen.getByRole('row').filter({ has: screen.getByText(/sk/) })).toHaveCount(0);", 1],
        ["await screen.getByLabel('Token').or(screen.getByText(/sk/)).count();", 1],
      ] as const) {
        const probed = await runCode(code);
        expect(probed.isError, code).toBe(true);
        expect(probed.text, code).toMatch(new RegExp(`^POLICY_DENIED: run_code: statement ${String(statement)} \\(.*\\) finds a locator by part of a text, and this project configures secrets`));
        expect(probed.text, code).toContain('nothing ran.');
      }
      const exact = await runCode("await screen.getByDisplayValue('sk-live-WRONG').count();");
      expect(exact.isError, exact.text).toBe(false);
      expect(exact.text).toContain('returned 0');
      // The refused block never opened /echo again: the field still holds the secret.
      const still = await runCode("await screen.getByLabel('Token').inputValue();");
      expect(still.text).toContain('returned "<secret:apiKey>"');
    });

    it('drafts the secret fills it ran in test_lines by name', async () => {
      const drafted = await call('test_lines');
      expect(drafted.text).toContain("\nawait screen.getByLabel('Password').fill(credentials.user('admin').password);\n");
      expect(drafted.text).toContain("\nawait screen.getByLabel('Token').fill(secrets.get('apiKey'));\n");
      expect(drafted.text).toContain("Import credentials and secrets from 'e2e'.");
    });

    it('never returns a secret value', () => {
      for (const text of returned) {
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(API_KEY);
        expect(text.toLowerCase()).not.toContain(API_KEY.toLowerCase());
      }
    });
  });
});
