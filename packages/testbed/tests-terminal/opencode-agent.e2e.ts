/**
 * OpenCode through the agent: the test agent drives a coding agent. Each
 * agentic step is paired with a deterministic check, and the flagship test
 * asserts on the disk, not the screen: OpenCode was asked to write a file,
 * so the file is the proof.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.ts';

const FILE_WAIT_MS = 120_000;

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + FILE_WAIT_MS;
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

test('opens the help dialog through the agent', async ({ agent, screen }) => {
  await agent.act('open the help dialog with the /help slash command');
  await agent.assert('a help dialog is shown on top of the prompt');
  await expect(screen.getByText('Help')).toBeVisible();
});

test('asks OpenCode to write a file and finds it on disk', async ({ agent, screen, terminal }) => {
  const file = path.join(terminal.cwd, 'hello.txt');
  rmSync(file, { force: true });

  await agent.act(
    'Send this message to OpenCode: "Create a file named hello.txt in the current directory containing exactly the text: hello from e2e" ' +
      'Type it into the prompt and press Enter. Then wait until OpenCode has finished responding.',
  );
  await waitForFile(file);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('hello from e2e');
  await agent.assert('OpenCode reports that it created or wrote hello.txt');
  await expect(screen.getByText(/hello\.txt/).first()).toBeVisible();
});
