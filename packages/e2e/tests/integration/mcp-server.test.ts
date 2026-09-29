/**
 * `e2e mcp` end to end: the built CLI serving a fixture project over stdio to
 * a real MCP client. The server's tool list is four tools; everything the
 * session can do is a catalog behind `call`. Covers the catalog, a live
 * session driven through `call`, argument validation, the secret and pixel
 * invariants, a video recording, a second session open beside the first, a
 * second session after the first closed, an explicit config path, and stdout
 * hygiene: a config that prints to stdout must not corrupt
 * the protocol.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

// The engine lives in a file the config imports, as a config that spreads a
// base config has it: each session must still get an engine of its own.
const TARGETS = `import { web } from '@e2e-dev/web';

export const targets = [{ name: 'web', platform: 'web', engine: web({ url: process.env.APP_URL! }) }];
`;

const CONFIG = `import type { E2EConfig } from 'e2e';
import { targets } from './targets.ts';

// Anything a config prints must reach stderr, never the protocol stream.
console.log('config loaded');

export default {
  targets,
  credentials: { admin: { username: 'admin', password: 'admin-pass' } },
  secrets: { apiKey: 'sk-live-SUPERSECRET-0000' },
} satisfies E2EConfig;
`;

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
  readonly images: number;
}

describe('e2e mcp', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = '';

  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return {
      text: result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
      isError: result.isError === true,
      images: result.content.filter((part) => part.type === 'image').length,
    };
  };

  /** A catalog tool through the server's `call` tool. */
  const call = (tool: string, args?: Record<string, unknown>): Promise<ToolText> => invoke('call', { tool, ...(args === undefined ? {} : { args }) });

  /** The node id of the first observation line matching `pattern`. */
  const nodeId = (text: string, pattern: RegExp): string => {
    const line = text.split('\n').find((candidate) => pattern.test(candidate));
    const match = line === undefined ? null : /#(n\d+)/.exec(line);
    if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
    return match[1]!;
  };

  const catalogLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('- '));

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG, 'targets.ts': TARGETS });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--headless'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: 'e2e-mcp-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it('serves four fixed tools and the guide resources', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['open_session', 'tools', 'call', 'close_session']);
    const callTool = tools.find((tool) => tool.name === 'call')!;
    expect(callTool.description).toContain('call {tool: "tap", args: {target: "n42"}, session: "<id>"}');
    expect(callTool.inputSchema).toMatchObject({ type: 'object', required: ['tool'] });
    expect(tools.find((tool) => tool.name === 'tools')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === 'open_session')?.inputSchema).toMatchObject({ properties: { target: {}, config: {} } });
    expect(client.getInstructions()).toContain('call {tool, args} runs any catalog tool');
    expect(client.getInstructions()).toContain('Several sessions can be open at once');

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['e2e://guide', 'e2e://guide/mcp', 'e2e://guide/writing-tests']),
    );
    const guide = await client.readResource({ uri: 'e2e://guide/mcp' });
    expect((guide.contents[0] as { text: string }).text).toContain('# Driving the app over MCP');
  });

  it('refuses tools and call before a session is open', async () => {
    const listed = await invoke('tools');
    expect(listed.isError).toBe(true);
    expect(listed.text).toContain('NO_SESSION');
    const observed = await call('observe');
    expect(observed.isError).toBe(true);
    expect(observed.text).toContain('NO_SESSION');
  });

  it('refuses an argument a fixed tool does not declare at the protocol layer, before anything runs', async () => {
    // The MCP SDK validates against the closed schema before the handler runs:
    // the refusal names the tool and the key, and no session opened.
    for (const [name, args, key] of [
      ['open_session', { headless: true }, 'headless'],
      ['tools', { all: true }, 'all'],
      ['call', { tool: 'observe', verbose: true }, 'verbose'],
      ['close_session', { force: true }, 'force'],
    ] as const) {
      const refused = await invoke(name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain(`Invalid arguments for tool ${name}: Unrecognized key: "${key}"`);
    }
    const listed = await invoke('tools');
    expect(listed.isError).toBe(true);
    expect(listed.text).toContain('NO_SESSION');
  });

  it('opens a session with its catalog, then locates, acts, fills a secret, and withholds pixels afterwards', async () => {
    const opened = await invoke('open_session');
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toMatch(/^Session \S+ open on target "web" \(platform web, engine web [^)]+\), headless; config .*e2e\.config\.ts\./);
    expect(opened.text).toContain(`App: ${app.url}/`);
    expect(opened.text).toContain('Credentials: "admin" (username "admin")');
    expect(opened.text).toContain('Tools (run one with call {tool, args}; tools {tool} shows a tool\'s arguments):');
    expect(catalogLines(opened.text)).toEqual([
      expect.stringMatching(/^- observe: Look at the whole current screen.* \[read-only\]$/),
      expect.stringMatching(/^- tap \{target\}: Tap or click one node: the gesture for a button, link, menu item, tab, checkbox, row, or field\.$/),
      expect.stringMatching(/^- double_tap \{target\}: Double-click one node: only for an item that opens or enters editing on the second click/),
      expect.stringMatching(/^- long_press \{target\}: Press one node and hold: only for a control with a long-press menu or action\.$/),
      expect.stringMatching(/^- right_click \{target\}: Right-click one node to open its context menu, and only for that\.$/),
      expect.stringMatching(/^- hover \{target\}: Move the pointer over one node without clicking/),
      expect.stringMatching(/^- scroll_to \{target\?, text\?, direction\?\}: Scroll until a node is inside the viewport/),
      expect.stringMatching(/^- type \{target\?, value, replace\?\}: Type a plain-text value into one input node, or into whatever has focus when target is omitted\.$/),
      expect.stringMatching(/^- press \{target\?, key, times\?\}: /),
      expect.stringMatching(/^- select \{target, value\}: /),
      expect.stringMatching(/^- check \{target, checked\?\}: Set a checkbox, switch, or radio to a state/),
      expect.stringMatching(/^- drag \{target, to\}: Drag one node and drop it on another/),
      expect.stringMatching(/^- upload \{target, files\}: Attach one or more files to a file input node\.$/),
      expect.stringMatching(/^- scroll \{direction, target\?, times\?\}: /),
      expect.stringMatching(/^- navigate \{url\}: /),
      expect.stringMatching(/^- back: Go back one step/),
      expect.stringMatching(/^- screenshot: Attach a screenshot of the current viewport.* \[read-only\]$/),
      expect.stringMatching(/^- tap_at \{x, y\}: Tap a point in the latest screenshot/),
      expect.stringMatching(/^- hover_at \{x, y\}: Move the pointer to a point in the latest screenshot/),
      expect.stringMatching(/^- type_at \{x, y, value, replace\?\}: Type a plain-text value into the field at a point/),
      expect.stringMatching(/^- press_at \{x, y, key\}: Send one key/),
      expect.stringMatching(/^- select_at \{x, y, value\}: Pick one option/),
      expect.stringMatching(/^- type_secret \{target, name\}: /),
      expect.stringMatching(/^- locate \{role\?, name\?, text\?, label\?, placeholder\?, testId\?, exact\?\}: .* \[read-only\]$/),
      expect.stringMatching(/^- start_recording \{name\?\}: Start recording a video of the app, for a person to watch: .*\.$/),
      expect.stringMatching(/^- stop_recording: Stop the running recording and save it: .*\.$/),
    ]);
    expect(opened.text).toMatch(/Current screen \(revision b\d+, path \/, \d+ nodes\):/);
    expect(opened.text).toContain('button "Increment"');
    const sessionId = /^Session (\S+) open/.exec(opened.text)![1]!;

    const listed = await invoke('tools');
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).toContain(`Session ${sessionId} on target "web": 26 tools.`);
    expect(catalogLines(listed.text)).toEqual(catalogLines(opened.text));
    const detail = await invoke('tools', { tool: 'type_secret' });
    expect(detail.text).toContain('"admin" (password)');
    expect(detail.text).toContain('Arguments (JSON Schema):');
    expect(detail.text).toContain('"required"');
    const unknown = await invoke('tools', { tool: 'teleport' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('UNKNOWN_TOOL');
    expect(unknown.text).toContain('tools: observe, tap, double_tap, long_press, right_click, hover, scroll_to, type');

    const unique = await call('locate', { role: 'button', name: 'Increment' });
    expect(unique.isError, unique.text).toBe(false);
    expect(unique.text).toContain('1 node matches');
    expect(unique.text).toContain('Use: screen.getByRole("button", { name: "Increment" })');
    const ambiguous = await call('locate', { text: 'Duplicated' });
    expect(ambiguous.text).toContain('2 nodes match');
    expect(ambiguous.text).toContain('LOCATOR_AMBIGUOUS');
    const missing = await call('locate', { label: 'Nowhere' });
    expect(missing.text).toContain('0 nodes match');
    expect(missing.text).toContain('LOCATOR_NOT_FOUND');

    const observed = await call('observe');
    const tapped = await call('tap', { target: nodeId(observed.text, /button "Increment"/) });
    expect(tapped.isError, tapped.text).toBe(false);
    // An action reports what changed on screen, as it does for the testing agent.
    expect(tapped.text).toMatch(/^Tapped #n\d+\.\n\nScreen changes since revision/);
    const after = await call('observe');
    expect(after.text).toMatch(/status "Counter" text="1"/);

    // Arguments are checked against the tool's own schema before it runs.
    const malformed = await call('tap', { target: 42 });
    expect(malformed.isError).toBe(true);
    expect(malformed.text).toMatch(/^INVALID_ARGUMENT: call tap: target: /);
    expect(malformed.text).toContain('tools {tool: "tap"} shows its arguments');
    // An argument the tool does not declare is refused the same way, never stripped and acted on.
    const decorated = await call('tap', { target: nodeId(after.text, /button "Increment"/), force: true });
    expect(decorated.isError).toBe(true);
    expect(decorated.text).toBe('INVALID_ARGUMENT: call tap: Unrecognized key: "force"; tools {tool: "tap"} shows its arguments');
    const nameless = await call('teleport');
    expect(nameless.isError).toBe(true);
    expect(nameless.text).toContain('UNKNOWN_TOOL');
    const elsewhere = await invoke('call', { tool: 'observe', session: 'not-this-one' });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toContain(`NO_SESSION: session "not-this-one" is not open; open: ${sessionId} on "web"`);

    // A stale id is refused the way the testing agent sees it: the action
    // reports its failure and the screen it re-observed, no wrong node acted on.
    const stale = await call('tap', { target: 'n9999' });
    expect(stale.text).toMatch(/^Tapped #n9999\. failed: .*n9999/);
    expect(stale.text).toContain('re-observe');

    const before = await call('screenshot');
    expect(before.isError, before.text).toBe(false);
    expect(before.images).toBe(1);
    expect(before.text).toContain('Screenshot attached: 768 by 432 pixels (0.6 per CSS pixel).');

    const filled = await call('type_secret', { target: nodeId(after.text, /textbox "Password"/), name: 'admin' });
    expect(filled.isError, filled.text).toBe(false);
    expect(filled.text).toContain('Filled secret "admin"');
    expect(filled.text).not.toContain('admin-pass');

    const tainted = await call('screenshot');
    expect(tainted.images).toBe(0);
    expect(tainted.text).toContain('No screenshot: a secret was filled in this attempt');
    expect(tainted.text).toContain('PIXEL_TAINTED');

    const denied = await call('navigate', { url: 'javascript:alert(1)' });
    expect(denied.text).toMatch(/^Navigated to javascript:alert\(1\)\. failed: /);
    expect(denied.text).toContain('forbidden URL scheme');

    // A second session opens beside the first on its own browser: while both
    // are open a call names its session, and each drives its own screen.
    const second = await invoke('open_session');
    expect(second.isError, second.text).toBe(false);
    const secondId = /^Session (\S+) open/.exec(second.text)![1]!;
    expect(secondId).not.toBe(sessionId);
    expect(second.text).toContain(`Pass session "${secondId}" to every tools, call, and close_session; with several sessions open, a call without it fails.`);
    const unnamed = await call('observe');
    expect(unnamed.isError).toBe(true);
    expect(unnamed.text).toMatch(new RegExp(`^SESSION_REQUIRED: 2 sessions are open; pass session to name one: ${sessionId} on "web", ${secondId} on "web"`));
    const secondScreen = await invoke('call', { tool: 'observe', session: secondId });
    expect(secondScreen.text).toMatch(/status "Counter" text="0"/);
    const firstScreen = await invoke('call', { tool: 'observe', session: sessionId });
    expect(firstScreen.text).toMatch(/status "Counter" text="1"/);
    const unnamedClose = await invoke('close_session');
    expect(unnamedClose.text).toContain('SESSION_REQUIRED');
    const closedSecond = await invoke('close_session', { session: secondId });
    expect(closedSecond.isError, closedSecond.text).toBe(false);
    const endedCall = await invoke('call', { tool: 'observe', session: secondId });
    expect(endedCall.isError).toBe(true);
    expect(endedCall.text).toContain(`NO_SESSION: session "${secondId}" ended: closed by the agent; call open_session for a new one`);

    const closed = await invoke('close_session', { session: sessionId });
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.text).toMatch(/^Session \S+ closed \(closed by the agent\); \d+ tool calls ran\./);
    expect(closed.text).not.toContain('Cleanup:');

    const gone = await call('observe');
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain('the previous session ended: closed by the agent');
  });

  it('records the app between start_recording and stop_recording, and saves a recording still running at close', async () => {
    const opened = await invoke('open_session');
    expect(opened.isError, opened.text).toBe(false);
    const sessionId = /^Session (\S+) open/.exec(opened.text)![1]!;
    const recordings = path.join(project.dir, '.e2e', 'videos', sessionId);

    const started = await call('start_recording', { name: 'counter' });
    expect(started.isError, started.text).toBe(false);
    const observed = await call('observe');
    await call('tap', { target: nodeId(observed.text, /button "Increment"/) });
    const stopped = await call('stop_recording');
    expect(stopped.isError, stopped.text).toBe(false);
    expect(stopped.text).toMatch(/^Recording 1 "counter" stopped after \d+\.\d s\.\n- \S+\.webm$/);
    const file = path.join(recordings, '1-counter.webm');
    expect(stopped.text.endsWith(`- ${file}`)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);

    await call('start_recording');
    const closed = await invoke('close_session');
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.text).toMatch(/\nRecording 2 stopped after \d+\.\d s\.\n- \S+$/);
    expect(closed.text.endsWith(`- ${path.join(recordings, '2.webm')}`)).toBe(true);
    expect(closed.text).not.toContain('Cleanup:');
    expect(readdirSync(recordings).toSorted()).toEqual(['1-counter.webm', '2.webm']);
  });

  it('opens a second session after the first closed, on an explicit config path, and names an unknown target', async () => {
    const unknown = await invoke('open_session', { target: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('UNKNOWN_TARGET');

    const absent = await invoke('open_session', { config: 'missing.config.ts' });
    expect(absent.isError).toBe(true);
    expect(absent.text).toContain('CONFIG_NOT_FOUND');

    const reopened = await invoke('open_session', { target: 'web', config: 'e2e.config.ts' });
    expect(reopened.isError, reopened.text).toBe(false);
    expect(reopened.text).toContain('button "Increment"');
    const closed = await invoke('close_session');
    expect(closed.isError, closed.text).toBe(false);
  });

  it('shows a generic secret filled into a plain textbox by name in locate and observe, never the plaintext', async () => {
    const opened = await invoke('open_session');
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain('Secrets: "apiKey"');

    // A generic secret fills any editable input, so the engine projects the
    // value the way it does for every non-secure field.
    const observed = await call('observe');
    const filled = await call('type_secret', { target: nodeId(observed.text, /textbox "Focus target"/), name: 'apiKey' });
    expect(filled.isError, filled.text).toBe(false);
    expect(filled.text).toContain('Filled secret "apiKey"');

    const located = await call('locate', { label: 'Focus target' });
    expect(located.isError, located.text).toBe(false);
    expect(located.text).toContain('1 node matches');
    expect(located.text).toContain('- textbox "Focus target" value "<secret:apiKey>"');
    const after = await call('observe');
    expect(after.text).toMatch(/textbox "Focus target" value="<secret:apiKey>"/);
    for (const output of [filled, located, after]) expect(output.text).not.toContain('sk-live-SUPERSECRET-0000');

    const closed = await invoke('close_session');
    expect(closed.isError, closed.text).toBe(false);
  });

  it('kept stdout for the protocol: the config\'s console.log landed on stderr', () => {
    expect(stderr).toContain('config loaded');
    expect(stderr).toContain('e2e mcp: [info] e2e mcp');
  });
});
