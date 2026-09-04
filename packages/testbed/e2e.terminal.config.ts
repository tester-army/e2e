/**
 * Opt-in terminal suite on the `@e2edev/tmux` backend: OpenCode's TUI as the
 * app under test, one honest terminal target with no browser and no app URL.
 * The backend starts OpenCode fresh in its own tmux window for every attempt,
 * in a throwaway workspace under `.e2e/` with its own OpenCode config (the
 * developer's MCP servers and plugins stay out of the picture, edits and
 * shell commands are pre-approved, sharing is off). Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:terminal
 *
 * Requires tmux and an `opencode` binary on PATH (or `OPENCODE_BIN`), logged
 * in to a provider; `OPENCODE_MODEL` picks the model OpenCode itself uses
 * (default: Claude Haiku 4.5, the cheap one). Not part of CI: every act step
 * spends real model calls, and the agent test asks OpenCode to do real work.
 * Add `--headed` to watch the run type into a Terminal.app window.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { tmux } from '@e2edev/tmux';
import { tmuxTools } from '@e2edev/tmux/tools';
import { createGateway } from 'ai';

const workspace = path.join(import.meta.dirname, '.e2e', 'opencode-workspace');
const xdgConfigHome = path.join(workspace, '.xdg-config');
mkdirSync(xdgConfigHome, { recursive: true });
writeFileSync(
  path.join(workspace, 'opencode.json'),
  `${JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      model: process.env.OPENCODE_MODEL ?? 'anthropic/claude-haiku-4-5',
      share: 'disabled',
      permission: { read: 'allow', edit: 'allow', bash: 'allow', glob: 'allow', grep: 'allow', list: 'allow' },
    },
    null,
    2,
  )}\n`,
);

const opencode = tmux({
  command: `${process.env.OPENCODE_BIN ?? 'opencode'} --pure`,
  cwd: workspace,
  env: { XDG_CONFIG_HOME: xdgConfigHome },
  ready: 'Ask anything',
  columns: 120,
  rows: 40,
});

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-terminal',
  tests: 'tests-terminal/**/*.e2e.ts',
  targets: [{ name: 'opencode', platform: 'terminal', backend: opencode }],
  timeout: 300_000,
  actionTimeout: 60_000,
  workers: 1,
  agent: {
    executor: createAgent({ tools: tmuxTools(opencode) }),
    model: createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ),
    maxModelCalls: 40,
    context: [
      'The surface is a terminal running OpenCode, an AI coding assistant with a',
      'full-screen text UI, observed as its rows of text. There is exactly one',
      'input, the keyboard, and it always goes to the program: the type verb',
      'types characters, press sends one key (Enter, Escape, Tab, ArrowDown,',
      'Control+C), send_keys sends a sequence or a chord. The row marked textbox',
      'is where the cursor is. Nothing is submitted until Enter is pressed.',
      'Slash commands (/help, /models, /exit) open a palette as you type; Enter',
      'runs the highlighted one and Escape closes the palette. Tab switches',
      'between the Build and Plan agents. OpenCode answers a message by',
      'streaming text into the screen; while it works the prompt shows a',
      'spinner or a working indicator, and it is done when the input row shows',
      'the placeholder again. Use wait_for_text to wait for output instead of',
      'observing in a loop. Do not press Control+C twice: that quits OpenCode.',
    ].join(' '),
  },
});
