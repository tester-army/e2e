/** Non-destructive project scaffolding (spec 06-cli.md). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as clack from '@clack/prompts';

const CONFIG_TEMPLATE = `import { defineConfig } from 'e2e';
import { createAgent } from 'e2e/agent';

export default defineConfig({
  specVersion: '0.1',
  app: {
    url: process.env.APP_URL ?? 'http://localhost:3000',
  },
  // The runner ships no intelligence: you construct the agent and pass it in.
  // createAgent builds the built-in one; its model comes from E2E_MODEL.
  agent: createAgent({
    system: 'You are a thorough QA agent. Verify every outcome on screen.',
  }),
  targets: [{ name: 'web', platform: 'web', browser: 'chromium' }],
});
`;

const EXAMPLE_TEMPLATE = `import { test, expect } from 'e2e';

test('app opens', async ({ app, web }) => {
  await app.open();
  await expect(web).toHaveURL('/');
});

// Runs when E2E_MODEL and E2E_MODEL_API_KEY are set:
// test('the agent drives a flow', async ({ app, agent }) => {
//   await app.open();
//   await agent.act('one goal in plain language');
//   await agent.assert('one question about the screen');
// });
`;

const GITIGNORE_ENTRIES = [
  '.e2e/artifacts/',
  '.e2e/cache/',
  '.e2e/sessions/',
  '.e2e/report.json',
];

interface PlannedFile {
  readonly relative: string;
  readonly content: string;
}

/** Runs `e2e init`. Creates only missing files and stops before any conflict. */
export async function init(cwd: string, options: { yes?: boolean } = {}): Promise<number> {
  clack.intro('e2e init');

  const planned: PlannedFile[] = [
    { relative: 'e2e.config.ts', content: CONFIG_TEMPLATE },
    { relative: path.join('tests', 'example.e2e.ts'), content: EXAMPLE_TEMPLATE },
  ];

  const conflicts = planned.filter((file) => existsSync(path.join(cwd, file.relative)));
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      clack.log.warn(`exists, not touching: ${conflict.relative}`);
    }
    const remaining = planned.filter((file) => !existsSync(path.join(cwd, file.relative)));
    if (remaining.length === 0) {
      clack.outro('nothing to create; project already initialized');
      return 0;
    }
  }

  if (options.yes !== true) {
    const proceed = await clack.confirm({
      message: `create ${planned
        .filter((file) => !existsSync(path.join(cwd, file.relative)))
        .map((file) => file.relative)
        .join(', ')} and update .gitignore?`,
    });
    if (clack.isCancel(proceed) || proceed !== true) {
      clack.cancel('cancelled; no changes were made');
      return 0;
    }
  }

  for (const file of planned) {
    const absolute = path.join(cwd, file.relative);
    if (existsSync(absolute)) continue;
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, 'utf8');
    clack.log.success(`created ${file.relative}`);
  }

  const gitignorePath = path.join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.split('\n');
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length > 0) {
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignorePath, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
    clack.log.success(`updated .gitignore (${missing.length} entries)`);
  }

  clack.outro('next: APP_URL=http://localhost:3000 npx --no-install e2e run');
  return 0;
}
