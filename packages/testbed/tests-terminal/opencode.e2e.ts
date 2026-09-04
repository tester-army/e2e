/**
 * One session of OpenCode's TUI, end to end: the test agent drives a coding
 * agent. Agentic steps carry the parts a person would do by eye (pick a
 * model in a picker, ask for work and wait for it), and every one of them is
 * paired with a deterministic check on the screen or the disk. Keyboard
 * mechanics (Tab, slash commands, Escape) stay deterministic so the run
 * spends model calls only where judgment is needed.
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

test('drives a full OpenCode session: model picker, agents, a coding task, help, and exit', async ({
  agent,
  screen,
  terminal,
}) => {
  // Launch: the prompt is up and the status line names the agent and the model.
  await expect(screen.getByText(/^Ask anything/)).toBeVisible();
  await expect(screen.getByText(/^Build · Claude Haiku 4\.5/)).toBeVisible();
  await expect(screen.getByText('ctrl+p commands')).toBeVisible();

  // Model picker, both ways: the agent searches the list and picks, the status line proves it.
  await agent.act('open the model picker with the /models command and select "Claude Sonnet 4.5 (latest)" from Anthropic');
  await expect(screen.getByText(/^Build · Claude Sonnet 4\.5/)).toBeVisible();
  await agent.assert('the status line at the bottom of the prompt shows Claude Sonnet 4.5 as the current model');
  await agent.act('open the model picker again and switch back to "Claude Haiku 4.5 (latest)" from Anthropic');
  await expect(screen.getByText(/^Build · Claude Haiku 4\.5/)).toBeVisible();

  // Agent switch is one key: Tab cycles Build and Plan.
  await terminal.press('Tab');
  await expect(screen.getByText(/^Plan · Claude Haiku 4\.5/)).toBeVisible();
  await terminal.press('Tab');
  await expect(screen.getByText(/^Build · Claude Haiku 4\.5/)).toBeVisible();

  // The coding task: OpenCode is asked to write a file, and the disk is the proof.
  const file = path.join(terminal.cwd, 'hello.txt');
  rmSync(file, { force: true });
  await agent.act(
    'Send this message to OpenCode: "Create a file named hello.txt in the current directory containing exactly the text: hello from e2e" ' +
      'Type it into the prompt and press Enter. Do not wait for the reply.',
  );
  await waitForFile(file);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('hello from e2e');
  await agent.assert('OpenCode reports that it created or wrote hello.txt');
  await expect(screen.getByText(/hello\.txt/).first()).toBeVisible();

  // Slash commands open a palette that filters as you type; Enter runs the highlighted one, Escape closes a dialog.
  // The typed text and the palette entry both read "/help"; the entry's description column is what proves the palette.
  await terminal.type('/help');
  await expect(screen.getByText('Help')).toBeVisible();
  await terminal.press('Enter');
  await expect(screen.getByText('Help')).toBeVisible();
  await expect(screen.getByText(/ctrl\+p to see all available actions/)).toBeVisible();
  await terminal.press('Escape');
  await expect(screen.getByText(/ctrl\+p to see all available actions/)).not.toBeVisible();

  // Exit: the program ends and its final screen stays observable.
  await terminal.type('/exit');
  await terminal.press('Enter');
  await terminal.waitForExit();
  expect(await terminal.exited()).toBe(true);
  await expect(screen.getByText(/the program exited/)).toBeVisible();
});
