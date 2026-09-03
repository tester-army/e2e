/** Non-destructive project scaffolding (spec 06-cli.md). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as clack from '@clack/prompts';

const CONFIG_TEMPLATE = `import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  specVersion: '0.1',
  app: {
    url: process.env.APP_URL ?? 'http://localhost:3000',
  },
  // The runner ships no intelligence. Deterministic tests and the judgment
  // calls (agent.assert, agent.waitFor, agent.extract) need only a model, read
  // from E2E_MODEL. agent.act() needs a step executor: build one on the
  // chassis from 'e2e/agent' (createToolLoopExecutor) or plug in a package
  // that provides one, and pass it as agent.executor.
  agent: {
    model: process.env.E2E_MODEL,
  },
  // The runner knows no platform: a target is served by the backend you pass.
  targets: [{ name: 'web', platform: 'web', backend: playwright({ browser: 'chromium' }) }],
});
`;

const EXAMPLE_TEMPLATE = `import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('app opens', async ({ app, web }) => {
  await app.open();
  await expect(web).toHaveURL('/');
});

// Runs when E2E_MODEL and E2E_MODEL_API_KEY are set; agent.act additionally
// needs agent.executor in the config:
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
  '.e2e/ai-trace.json',
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
  for (const conflict of conflicts) {
    clack.log.warn(`exists, not touching: ${conflict.relative}`);
  }
  const remaining = planned.filter((file) => !existsSync(path.join(cwd, file.relative)));

  // The ignore list is reconciled on every run, not only the first: a project
  // initialized before an entry existed (`.e2e/ai-trace.json`, say) picks it
  // up by re-running init, without touching any scaffold file.
  const gitignorePath = path.join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.split('\n');
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));

  if (remaining.length === 0 && missing.length === 0) {
    clack.outro('nothing to create; project already initialized');
    return 0;
  }

  if (options.yes !== true) {
    const actions = [
      ...(remaining.length === 0
        ? []
        : [`create ${remaining.map((file) => file.relative).join(', ')}`]),
      ...(missing.length === 0 ? [] : ['update .gitignore']),
    ];
    const proceed = await clack.confirm({ message: `${actions.join(' and ')}?` });
    if (clack.isCancel(proceed) || proceed !== true) {
      clack.cancel('cancelled; no changes were made');
      return 0;
    }
  }

  for (const file of remaining) {
    const absolute = path.join(cwd, file.relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, 'utf8');
    clack.log.success(`created ${file.relative}`);
  }

  if (missing.length > 0) {
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignorePath, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
    clack.log.success(`updated .gitignore (${missing.length} entries)`);
  }

  if (remaining.length === 0) {
    clack.outro('project already initialized; .gitignore brought up to date');
    return 0;
  }

  clack.outro('next: install @e2edev/playwright, then APP_URL=http://localhost:3000 npx --no-install e2e run');
  return 0;
}
